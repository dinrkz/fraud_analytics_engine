"""Behavioral fraud-rule checks; unittest and statistics require no test framework."""

from dataclasses import replace
import statistics
import unittest

from analytics_engine.app.rules import Baseline, evaluate, update_moments


def rule(threshold, window_seconds=None, enabled=True):
    return {"enabled": enabled, "threshold": threshold, "window_seconds": window_seconds}


def codes(amount, baseline, rules, country="US"):
    return {hit["code"] for hit in evaluate(amount, country, baseline, rules)}


class FraudRuleTests(unittest.TestCase):
    def test_high_amount_includes_exact_threshold(self):
        rules = {"HIGH_AMOUNT": rule(5000)}
        self.assertEqual(codes(4999.99, Baseline(), rules), set())
        self.assertEqual(codes(5000, Baseline(), rules), {"HIGH_AMOUNT"})

    def test_spike_requires_twenty_previous_transactions(self):
        rules = {"AMOUNT_SPIKE": rule(3)}
        prior = Baseline(count=19, mean=100, m2=0)
        self.assertEqual(codes(1000, prior, rules), set())
        self.assertEqual(codes(1000, replace(prior, count=20), rules), {"AMOUNT_SPIKE"})

    def test_spike_uses_sample_deviation_and_strict_boundary(self):
        # 19 * 10^2 is M2 for 20 observations with a sample deviation of exactly 10.
        prior = Baseline(count=20, mean=100, m2=1900)
        rules = {"AMOUNT_SPIKE": rule(3)}
        self.assertEqual(codes(130, prior, rules), set())
        self.assertEqual(codes(130.01, prior, rules), {"AMOUNT_SPIKE"})

    def test_zero_variance_low_spending_has_hundred_dollar_floor(self):
        prior = Baseline(count=20, mean=5, m2=0)
        rules = {"AMOUNT_SPIKE": rule(3)}
        self.assertEqual(codes(100, prior, rules), set())
        self.assertEqual(codes(100.01, prior, rules), {"AMOUNT_SPIKE"})

    def test_current_amount_does_not_contaminate_scoring_baseline(self):
        prior = Baseline(count=20, mean=100, m2=1900)
        rules = {"AMOUNT_SPIKE": rule(3)}
        self.assertEqual(codes(131, prior, rules), {"AMOUNT_SPIKE"})
        self.assertEqual(prior, Baseline(count=20, mean=100, m2=1900))
        # Including the candidate first would raise the boundary and hide this spike.
        count, mean, m2 = update_moments(prior.count, prior.mean, prior.m2, 131)
        contaminated = Baseline(count=count, mean=mean, m2=m2)
        self.assertEqual(codes(131, contaminated, rules), set())

    def test_velocity_counts_current_event_once(self):
        rules = {"VELOCITY": rule(6, window_seconds=60)}
        self.assertEqual(codes(20, Baseline(recent_count=4), rules), set())
        self.assertEqual(codes(20, Baseline(recent_count=5), rules), {"VELOCITY"})
        self.assertEqual(codes(20, Baseline(recent_count=6), rules), {"VELOCITY"})

    def test_country_hop_includes_both_time_boundaries(self):
        rules = {"COUNTRY_HOP": rule(1, window_seconds=300)}
        for seconds in (0, 300):
            with self.subTest(seconds=seconds):
                prior = Baseline(previous_country="GB", previous_age_seconds=seconds)
                self.assertEqual(codes(20, prior, rules), {"COUNTRY_HOP"})

    def test_country_hop_rejects_outside_window_and_future_history(self):
        rules = {"COUNTRY_HOP": rule(1, window_seconds=300)}
        for seconds in (-0.001, 300.001):
            with self.subTest(seconds=seconds):
                prior = Baseline(previous_country="GB", previous_age_seconds=seconds)
                self.assertEqual(codes(20, prior, rules), set())

    def test_country_hop_requires_country_change_and_previous_event(self):
        rules = {"COUNTRY_HOP": rule(1, window_seconds=300)}
        for prior in (Baseline(), Baseline(previous_country="US", previous_age_seconds=1),
                      Baseline(previous_country="GB")):
            with self.subTest(prior=prior):
                self.assertEqual(codes(20, prior, rules), set())

    def test_all_applicable_rules_can_alert_on_one_event(self):
        rules = {"HIGH_AMOUNT": rule(5000), "AMOUNT_SPIKE": rule(3),
                 "VELOCITY": rule(6, 60), "COUNTRY_HOP": rule(1, 300)}
        prior = Baseline(count=20, mean=100, m2=1900, recent_count=5,
                         previous_country="GB", previous_age_seconds=10)
        hits = evaluate(5000, "US", prior, rules)
        self.assertEqual({hit["code"] for hit in hits}, set(rules))
        self.assertEqual(len(hits), 4)
        self.assertEqual(max(hit["score"] for hit in hits), 90)
        self.assertTrue(all(hit["description"] for hit in hits))

    def test_missing_and_disabled_rules_do_not_alert(self):
        prior = Baseline(count=20, mean=100, m2=1900, recent_count=10,
                         previous_country="GB", previous_age_seconds=10)
        disabled = {code: rule(1, 300, enabled=False)
                    for code in ("HIGH_AMOUNT", "AMOUNT_SPIKE", "VELOCITY", "COUNTRY_HOP")}
        self.assertEqual(codes(10000, prior, {}), set())
        self.assertEqual(codes(10000, prior, disabled), set())


class RunningMomentTests(unittest.TestCase):
    def test_first_observation_and_constant_series(self):
        state = (0, 0.0, 0.0)
        for count in range(1, 26):
            state = update_moments(*state, 42)
            self.assertEqual(state, (count, 42.0, 0.0))

    def test_sample_variance_matches_independent_statistics(self):
        values = [12.25, 29.50, 18.00, 62.75, 3.50, 170.25]
        state = (0, 0.0, 0.0)
        for value in values:
            state = update_moments(*state, value)
        count, mean, m2 = state
        self.assertEqual(count, len(values))
        self.assertAlmostEqual(mean, statistics.mean(values), places=10)
        self.assertAlmostEqual(m2 / (count - 1), statistics.variance(values), places=10)

    def test_large_offset_does_not_destroy_small_variance(self):
        values = [1_000_000_000.0 + offset for offset in (1, 2, 3, 4, 5)]
        state = (0, 0.0, 0.0)
        for value in values:
            state = update_moments(*state, value)
        self.assertEqual(state[1], statistics.mean(values))
        self.assertAlmostEqual(state[2] / (state[0] - 1), statistics.variance(values), places=10)


if __name__ == "__main__":
    unittest.main()
