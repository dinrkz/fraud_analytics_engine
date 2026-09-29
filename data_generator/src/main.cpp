#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

volatile std::sig_atomic_t running = 1;
void stop(int) { running = 0; }

struct Options {
    double rate = 20;
    std::uint64_t count = 0;
    std::uint64_t seed = 0;
    bool seed_supplied = false;
    std::uint32_t users = 1000;
    double fraud_rate = 0.08;
    std::string start_time;
    std::string output;
    std::string run_id;
};

void usage(std::ostream& out) {
    out << "OpenTrace synthetic transaction generator\n"
        << "Usage: transaction_generator [options]\n"
        << "  --rate N          Events/second; 0 = unlimited (default 20)\n"
        << "  --count N         Stop after N events; 0 = infinite (default 0)\n"
        << "  --seed N          Unsigned 64-bit random seed\n"
        << "  --users N         Number of users, 2..1000000 (default 1000)\n"
        << "  --fraud-rate N    Probability of starting an anomaly scenario, 0..1 (default .08)\n"
        << "  --start-time UTC  Logical start, e.g. 2026-01-01T00:00:00Z\n"
        << "  --run-id TEXT     Stable identity for reproducible event IDs\n"
        << "  --output PATH     Write JSONL to a file instead of stdout\n"
        << "  --help            Show this help\n";
}

std::uint64_t integer(const std::string& value, const std::string& option) {
    std::uint64_t number = 0;
    const auto result = std::from_chars(value.data(), value.data() + value.size(), number);
    if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
        throw std::invalid_argument(option + " must be a non-negative integer");
    }
    return number;
}

double decimal(const std::string& value, const std::string& option) {
    std::size_t end = 0;
    double number = 0;
    try { number = std::stod(value, &end); }
    catch (const std::exception&) { throw std::invalid_argument(option + " must be a finite number"); }
    if (end != value.size() || !std::isfinite(number)) {
        throw std::invalid_argument(option + " must be a finite number");
    }
    return number;
}

Options parse(int argc, char* argv[]) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::string key = argv[i];
        if (key == "--help" || key == "-h") { usage(std::cout); std::exit(EXIT_SUCCESS); }
        if (i + 1 == argc) { throw std::invalid_argument("Missing value for " + key); }
        const std::string value = argv[++i];
        if (key == "--rate") options.rate = decimal(value, key);
        else if (key == "--count") options.count = integer(value, key);
        else if (key == "--seed") { options.seed = integer(value, key); options.seed_supplied = true; }
        else if (key == "--users") {
            const auto users = integer(value, key);
            if (users < 2 || users > 1000000) throw std::invalid_argument("--users must be between 2 and 1000000");
            options.users = static_cast<std::uint32_t>(users);
        }
        else if (key == "--fraud-rate") options.fraud_rate = decimal(value, key);
        else if (key == "--start-time") options.start_time = value;
        else if (key == "--output") options.output = value;
        else if (key == "--run-id") options.run_id = value;
        else throw std::invalid_argument("Unknown option: " + key);
    }
    if (options.rate < 0 || options.rate > 1000000000) throw std::invalid_argument("--rate must be between 0 and 1000000000");
    if (options.rate > 0 && options.rate < 0.001) throw std::invalid_argument("--rate must be 0 or at least 0.001");
    if (options.fraud_rate < 0 || options.fraud_rate > 1) throw std::invalid_argument("--fraud-rate must be between 0 and 1");
    if (options.count >= (std::uint64_t{1} << 62)) throw std::invalid_argument("--count must be below 2^62");
    return options;
}

// Gregorian civil date to Unix days. The inverse below avoids platform-specific timegm limits.
std::int64_t civil_days(int year, unsigned month, unsigned day) {
    year -= month <= 2;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(year - era * 400);
    const unsigned shifted_month = month > 2 ? month - 3 : month + 9;
    const unsigned doy = (153 * shifted_month + 2) / 5 + day - 1;
    return static_cast<std::int64_t>(era) * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

std::int64_t parse_time(const std::string& value) {
    if (value.size() != 20 || value[4] != '-' || value[7] != '-' || value[10] != 'T'
        || value[13] != ':' || value[16] != ':' || value[19] != 'Z') {
        throw std::invalid_argument("--start-time must be YYYY-MM-DDTHH:MM:SSZ (UTC)");
    }
    const auto part = [&value](std::size_t offset, std::size_t length) {
        return static_cast<int>(integer(value.substr(offset, length), "--start-time"));
    };
    const int year = part(0, 4), month = part(5, 2), day = part(8, 2);
    const int hour = part(11, 2), minute = part(14, 2), second = part(17, 2);
    constexpr std::array<int, 12> month_days{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    if (year < 1970 || year > 9998 || month < 1 || month > 12 || day < 1
        || day > month_days[static_cast<std::size_t>(month - 1)] + (month == 2 && leap ? 1 : 0)
        || hour > 23 || minute > 59 || second > 59) {
        throw std::invalid_argument("--start-time is not a valid UTC date in years 1970..9998");
    }
    return (civil_days(year, static_cast<unsigned>(month), static_cast<unsigned>(day)) * 86400
            + hour * 3600 + minute * 60 + second) * 1000000;
}

std::string timestamp(std::int64_t micros) {
    const std::int64_t seconds = micros / 1000000;
    std::int64_t days = seconds / 86400 + 719468;
    const std::int64_t era = days / 146097;
    const auto doe = static_cast<unsigned>(days - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int year = static_cast<int>(yoe) + static_cast<int>(era) * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned day = doy - (153 * mp + 2) / 5 + 1;
    const unsigned month = mp < 10 ? mp + 3 : mp - 9;
    year += month <= 2;
    if (year > 9999) throw std::overflow_error("Event time exceeds RFC3339 year range");
    const auto time = seconds % 86400;
    std::ostringstream out;
    out << std::setfill('0') << std::setw(4) << year << '-' << std::setw(2) << month << '-'
        << std::setw(2) << day << 'T' << std::setw(2) << time / 3600 << ':'
        << std::setw(2) << time / 60 % 60 << ':' << std::setw(2) << time % 60 << '.'
        << std::setw(6) << micros % 1000000 << 'Z';
    return out.str();
}

std::uint64_t entropy() {
    std::random_device source;
    const auto now = static_cast<std::uint64_t>(std::chrono::high_resolution_clock::now().time_since_epoch().count());
    return (static_cast<std::uint64_t>(source()) << 32) ^ source() ^ now;
}

std::uint64_t stable_hash(const std::string& text) {
    std::uint64_t hash = 14695981039346656037ULL;
    for (unsigned char byte : text) { hash ^= byte; hash *= 1099511628211ULL; }
    return hash;
}

std::string event_id(std::uint64_t run, std::uint64_t sequence) {
    // 60 bits of run identity + a 62-bit counter, with UUID version/variant bits.
    const std::uint64_t first = (run & 0xffffffffffff0fffULL) | 0x4000ULL;
    const std::uint64_t last = sequence | 0x8000000000000000ULL;
    std::ostringstream out;
    out << std::hex << std::setfill('0') << std::setw(8) << (first >> 32) << '-'
        << std::setw(4) << ((first >> 16) & 0xffff) << '-' << std::setw(4) << (first & 0xffff)
        << '-' << std::setw(4) << (last >> 48) << '-' << std::setw(12) << (last & 0xffffffffffffULL);
    return out.str();
}

struct Transaction {
    std::uint32_t sender;
    std::uint32_t receiver;
    std::uint64_t cents;
    std::size_t country;
    std::size_t merchant;
    bool transfer;
};

class Generator {
public:
    explicit Generator(const Options& options)
        : rng_(options.seed), users_(options.users), anomaly_(options.fraud_rate) {}

    Transaction next() {
        if (pending_ > 0) {
            --pending_;
            Transaction event = ordinary(scenario_sender_);
            if (country_hop_) event.country = (home(scenario_sender_) + 3) % 7;
            return event;
        }
        const auto sender = user();
        Transaction event = ordinary(sender);
        if (!anomaly_(rng_)) return event;
        switch (random(0, 2)) {
            case 0: event.cents = random(500000, 2500000); break;
            case 1:
                // First establish the sender's home, then jump country on the next event.
                scenario_sender_ = sender; country_hop_ = true; pending_ = 1; break;
            default:
                scenario_sender_ = sender; country_hop_ = false; pending_ = 7; break;
        }
        return event;
    }

private:
    std::mt19937_64 rng_;
    std::uint32_t users_;
    std::bernoulli_distribution anomaly_;
    std::lognormal_distribution<double> amount_{3.55, 0.85};
    std::uint32_t scenario_sender_ = 1;
    unsigned pending_ = 0;
    bool country_hop_ = false;

    std::uint64_t random(std::uint64_t low, std::uint64_t high) {
        return std::uniform_int_distribution<std::uint64_t>(low, high)(rng_);
    }
    std::uint32_t user() { return static_cast<std::uint32_t>(random(1, users_)); }
    static std::size_t home(std::uint32_t sender) { return (sender - 1) % 7; }
    Transaction ordinary(std::uint32_t sender) {
        // Draw directly from the other users without rejection for the two-user edge case.
        auto receiver = static_cast<std::uint32_t>(random(1, users_ - 1));
        if (receiver >= sender) ++receiver;
        const auto cents = static_cast<std::uint64_t>(std::llround(std::clamp(amount_(rng_), 0.5, 1500.0) * 100));
        return {sender, receiver, cents, home(sender), static_cast<std::size_t>(random(0, 7)), random(0, 4) == 0};
    }
};

void write_event(std::ostream& out, const Transaction& event, std::uint64_t run,
                 std::uint64_t sequence, std::int64_t created_at) {
    constexpr std::array<const char*, 7> countries{"US", "GB", "DE", "FR", "JP", "SG", "KZ"};
    constexpr std::array<const char*, 8> merchants{"Northstar Market", "Metro Coffee", "Orbit Electronics",
        "City Transit", "Green Basket", "Atlas Travel", "Cloud Books", "Harbor Outfitters"};
    // Strings are from controlled ASCII constants; user input is never embedded in JSON.
    out << "{\"event_id\":\"" << event_id(run, sequence) << "\",\"sender_id\":" << event.sender
        << ",\"receiver_id\":" << event.receiver << ",\"amount\":\"" << event.cents / 100 << '.'
        << std::setfill('0') << std::setw(2) << event.cents % 100 << "\",\"currency\":\"USD\",\"country\":\""
        << countries[event.country] << "\",\"merchant\":\"" << merchants[event.merchant]
        << "\",\"sender_ip\":\"10." << (event.sender >> 16) % 256 << '.' << (event.sender >> 8) % 256
        << '.' << event.sender % 256 << "\",\"device_id\":\"device-" << event.sender
        << "\",\"transaction_type\":\"" << (event.transfer ? "transfer" : "purchase")
        << "\",\"created_at\":\"" << timestamp(created_at) << "\"}\n";
}

void sleep_interruptibly(std::chrono::steady_clock::time_point until) {
    while (running) {
        const auto now = std::chrono::steady_clock::now();
        if (now >= until) break;
        std::this_thread::sleep_for(std::min(until - now,
            std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::milliseconds(50))));
    }
}

} // namespace

int main(int argc, char* argv[]) {
    try {
        std::ios::sync_with_stdio(false);
        std::locale::global(std::locale::classic());
        auto options = parse(argc, argv);
        if (!options.seed_supplied) options.seed = entropy();
        const auto run = options.run_id.empty() ? entropy() : stable_hash(options.run_id);
        const std::int64_t start_time = options.start_time.empty()
            ? std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count()
            : parse_time(options.start_time);
        std::signal(SIGINT, stop);
        std::signal(SIGTERM, stop);
#ifdef SIGPIPE
        std::signal(SIGPIPE, SIG_IGN);
#endif
        std::ofstream file;
        std::ostream* output = &std::cout;
        if (!options.output.empty()) {
            file.open(options.output, std::ios::out | std::ios::binary | std::ios::trunc);
            if (!file) throw std::runtime_error("Cannot open output file: " + options.output);
            output = &file;
        }
        Generator generator(options);
        const auto start = std::chrono::steady_clock::now();
        auto last_flush = start;
        const double step_us = options.rate > 0 ? 1000000.0 / options.rate : 50000.0;
        std::uint64_t emitted = 0;
        std::int64_t previous_time = start_time - 1;
        std::cerr << "OpenTrace generator started: seed=" << options.seed << ", rate=" << options.rate
                  << ", users=" << options.users << '\n';
        while (running && (options.count == 0 || emitted < options.count)) {
            if (emitted >= (std::uint64_t{1} << 62)) throw std::overflow_error("Event counter exhausted");
            if (options.rate > 0) {
                const auto delay = std::chrono::duration<double>(static_cast<double>(emitted) / options.rate);
                sleep_interruptibly(start + std::chrono::duration_cast<std::chrono::steady_clock::duration>(delay));
                if (!running) break;
            }
            const auto offset = static_cast<long double>(emitted) * step_us;
            if (offset > static_cast<long double>(std::numeric_limits<std::int64_t>::max() - start_time - 1)) {
                throw std::overflow_error("Event timestamp exhausted");
            }
            const auto source_time = options.start_time.empty()
                ? std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count()
                : start_time + static_cast<std::int64_t>(offset);
            const auto event_time = std::max(previous_time + 1, source_time);
            write_event(*output, generator.next(), run, emitted, event_time);
            previous_time = event_time;
            ++emitted;
            const auto now = std::chrono::steady_clock::now();
            // Low-rate streams must be visible immediately. Bulk runs retain buffering.
            if ((options.rate > 0 && options.rate <= 20) || now - last_flush >= std::chrono::milliseconds(100)
                || emitted % 256 == 0) {
                output->flush(); last_flush = now;
            }
            if (!*output) throw std::runtime_error("Output stream failed (consumer closed or disk full)");
        }
        output->flush();
        if (!*output) throw std::runtime_error("Failed to flush output stream");
        const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        std::cerr << "OpenTrace generator stopped: events=" << emitted << ", elapsed_seconds=" << elapsed << '\n';
        return EXIT_SUCCESS;
    } catch (const std::exception& error) {
        std::cerr << "Generator error: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
