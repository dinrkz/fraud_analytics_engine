-- OpenTrace runtime schema. The original pg_dump remains in db/sql/v1_schema.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS users (
    id bigint PRIMARY KEY,
    username varchar(40) NOT NULL UNIQUE,
    email varchar(255) NOT NULL UNIQUE,
    reg_country varchar(2) NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rules (
    code varchar(40) PRIMARY KEY,
    name varchar(100) NOT NULL,
    description text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    threshold numeric NOT NULL CHECK (threshold > 0),
    window_seconds integer NOT NULL DEFAULT 0 CHECK (window_seconds >= 0)
);
INSERT INTO rules(code,name,description,threshold,window_seconds) VALUES
 ('HIGH_AMOUNT','High amount','A single transaction of $5,000 or more.',5000,0),
 ('AMOUNT_SPIKE','Unusual spending','Amount exceeds the prior mean by 3 standard deviations, after 20 observations (minimum $100).',3,0),
 ('VELOCITY','Transaction burst','At least 6 transactions by the same sender within 60 event-time seconds.',6,60),
 ('COUNTRY_HOP','Rapid country change','A different country from the preceding transaction within 5 event-time minutes.',1,300)
ON CONFLICT (code) DO NOTHING;
CREATE TABLE IF NOT EXISTS transactions (
    id bigserial PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE,
    sender_id bigint NOT NULL REFERENCES users(id),
    receiver_id bigint NOT NULL REFERENCES users(id),
    amount numeric(15,2) NOT NULL CHECK (amount > 0),
    currency varchar(3) NOT NULL CHECK (currency = 'USD'),
    country varchar(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    merchant varchar(100) NOT NULL,
    transaction_type varchar(40) NOT NULL,
    sender_ip inet NOT NULL,
    device_id varchar(64) NOT NULL,
    created_at timestamptz NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    risk_score numeric(5,2) NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
    is_flagged boolean NOT NULL DEFAULT false,
    CHECK (sender_id <> receiver_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_sender_time ON transactions(sender_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_flagged_time ON transactions(created_at DESC) WHERE is_flagged;
CREATE TABLE IF NOT EXISTS fraud_alerts (
    id bigserial PRIMARY KEY,
    transaction_id bigint NOT NULL REFERENCES transactions(id),
    rule_code varchar(40) NOT NULL REFERENCES rules(code),
    risk_score numeric(5,2) NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    description text NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','dismissed')),
    detected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (transaction_id,rule_code)
);
CREATE INDEX IF NOT EXISTS idx_alert_status_time ON fraud_alerts(status,detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_detected ON fraud_alerts(detected_at DESC);
CREATE TABLE IF NOT EXISTS user_metrics (
    user_id bigint PRIMARY KEY REFERENCES users(id),
    event_count bigint NOT NULL DEFAULT 0,
    total_amount numeric(22,2) NOT NULL DEFAULT 0,
    mean_amount double precision NOT NULL DEFAULT 0,
    m2_amount double precision NOT NULL DEFAULT 0,
    last_event_at timestamptz,
    last_country varchar(2),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS engine_state (
    id integer PRIMARY KEY CHECK (id = 1),
    last_heartbeat_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_events bigint NOT NULL DEFAULT 0,
    rejected_events bigint NOT NULL DEFAULT 0,
    generator_running boolean NOT NULL DEFAULT false,
    last_error text
);
INSERT INTO engine_state(id) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
