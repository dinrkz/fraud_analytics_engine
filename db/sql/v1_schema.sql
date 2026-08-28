--
-- PostgreSQL database dump
--

\restrict HVv7rPBl212KQbM3vB6LxpYBbHW9MDI3bEVYxM06pNloaHRbYPGaFqi31p1nAF7

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

-- Started on 2026-08-28 16:45:06

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 224 (class 1259 OID 25303)
-- Name: fraud_alerts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fraud_alerts (
    id integer NOT NULL,
    transaction_id bigint,
    risk_score numeric(5,2),
    rule_triggered character varying(100) NOT NULL,
    description text NOT NULL,
    status character varying(20) DEFAULT 'new'::character varying,
    detected_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.fraud_alerts OWNER TO postgres;

--
-- TOC entry 223 (class 1259 OID 25302)
-- Name: fraud_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.fraud_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.fraud_alerts_id_seq OWNER TO postgres;

--
-- TOC entry 5048 (class 0 OID 0)
-- Dependencies: 223
-- Name: fraud_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.fraud_alerts_id_seq OWNED BY public.fraud_alerts.id;


--
-- TOC entry 222 (class 1259 OID 25281)
-- Name: transactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transactions (
    id bigint NOT NULL,
    sender_id bigint,
    receiver_id bigint,
    amount numeric(15,2),
    currency character varying(4),
    transaction_type character varying(40),
    sender_ip inet,
    device_id character varying(64),
    is_international boolean NOT NULL,
    is_first_time_receiver boolean,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.transactions OWNER TO postgres;

--
-- TOC entry 221 (class 1259 OID 25280)
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.transactions_id_seq OWNER TO postgres;

--
-- TOC entry 5049 (class 0 OID 0)
-- Dependencies: 221
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- TOC entry 220 (class 1259 OID 25256)
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    username character varying(30) NOT NULL,
    login character varying(50),
    email character varying(255) NOT NULL,
    data_regis timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(20) DEFAULT 'Active'::character varying NOT NULL,
    reg_country character varying(80) NOT NULL,
    risk_level character varying(10) DEFAULT 'Medium'::character varying,
    CONSTRAINT users_email_check CHECK (((email)::text ~* '^[A-Za-z0-9._%+-]+@gmail\.com$'::text)),
    CONSTRAINT users_login_check CHECK ((length((login)::text) > 3)),
    CONSTRAINT users_username_check CHECK ((length((username)::text) > 3))
);


ALTER TABLE public.users OWNER TO postgres;

--
-- TOC entry 219 (class 1259 OID 25255)
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO postgres;

--
-- TOC entry 5050 (class 0 OID 0)
-- Dependencies: 219
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- TOC entry 4872 (class 2604 OID 25306)
-- Name: fraud_alerts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fraud_alerts ALTER COLUMN id SET DEFAULT nextval('public.fraud_alerts_id_seq'::regclass);


--
-- TOC entry 4870 (class 2604 OID 25284)
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- TOC entry 4866 (class 2604 OID 25259)
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- TOC entry 4891 (class 2606 OID 25315)
-- Name: fraud_alerts fraud_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fraud_alerts
    ADD CONSTRAINT fraud_alerts_pkey PRIMARY KEY (id);


--
-- TOC entry 4889 (class 2606 OID 25291)
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- TOC entry 4879 (class 2606 OID 25278)
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- TOC entry 4881 (class 2606 OID 25276)
-- Name: users users_login_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_login_key UNIQUE (login);


--
-- TOC entry 4883 (class 2606 OID 25272)
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- TOC entry 4885 (class 2606 OID 25274)
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- TOC entry 4892 (class 1259 OID 25323)
-- Name: idx_fraud_alerts_risk_score; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fraud_alerts_risk_score ON public.fraud_alerts USING btree (risk_score);


--
-- TOC entry 4886 (class 1259 OID 25321)
-- Name: idx_transactions_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transactions_created_at ON public.transactions USING btree (created_at);


--
-- TOC entry 4887 (class 1259 OID 25322)
-- Name: idx_transactions_sender_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_transactions_sender_id ON public.transactions USING btree (sender_id);


--
-- TOC entry 4895 (class 2606 OID 25316)
-- Name: fraud_alerts fraud_alerts_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fraud_alerts
    ADD CONSTRAINT fraud_alerts_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);


--
-- TOC entry 4893 (class 2606 OID 25297)
-- Name: transactions transactions_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES public.users(id);


--
-- TOC entry 4894 (class 2606 OID 25292)
-- Name: transactions transactions_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


-- Completed on 2026-08-28 16:45:06

--
-- PostgreSQL database dump complete
--

\unrestrict HVv7rPBl212KQbM3vB6LxpYBbHW9MDI3bEVYxM06pNloaHRbYPGaFqi31p1nAF7

