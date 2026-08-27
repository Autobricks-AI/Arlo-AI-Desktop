-- The schema.
--
-- Applied by migrate() in src/server/db.ts, in filename order, once each. A schema change is
-- a NEW numbered file: never an edit to one that has already run, because a file already
-- recorded in schema_migrations will not run again.
--
-- Tables scoped to a workspace carry row-level security and a policy pair keyed on
-- workspace_id. A new one belongs in the same file that creates the table; test/rls.test.js
-- is what proves it holds.

CREATE FUNCTION app_workspace() RETURNS integer
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('app.workspace_id', true), '')::integer $$;

CREATE FUNCTION split_person_name(raw text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  n     text;
  parts text[];
  n_parts int;
begin
  -- A nickname in brackets belongs to neither half: "Kar Wei (Kary) Loh" is Kar Wei Loh.
  n := btrim(regexp_replace(coalesce(raw, ''), '\([^)]*\)', ' ', 'g'));
  n := btrim(regexp_replace(n, '\s+', ' ', 'g'));

  /*
   * Not a person's name, so leave both blank.
   *
   * An address, a phone number or a support-queue subject cut into halves is worse than a
   * blank: a blank is visibly missing, whereas "info@" as a first name looks like somebody
   * meant it and gets used in a greeting.
   */
  if n = '' or n ~ '[@0-9]' or length(n) > 80 then
    return array[null, null]::text[];
  end if;

  -- "Loh, Kar Wei": the one form that says outright which half is the family name.
  if position(',' in n) > 0 then
    return array[nullif(btrim(split_part(n, ',', 2)), ''), nullif(btrim(split_part(n, ',', 1)), '')];
  end if;

  -- A title is how somebody is addressed, not what they are called.
  n := btrim(regexp_replace(n, '^(mr|mrs|ms|miss|mdm|madam|dr|prof|sir)\.?\s+', '', 'i'));

  parts := regexp_split_to_array(n, ' ');
  n_parts := array_length(parts, 1);

  -- One word: a mononym, a handle, or a company writing in. That is their name: inventing
  -- a surname to go with it would be making something up.
  if n_parts = 1 then
    return array[parts[1], null];
  end if;

  -- A particle belongs to the family name, not the given one: "Ludwig van Beethoven" is a
  -- Beethoven, and "van" on its own is nobody.
  if n_parts > 2 and lower(parts[n_parts - 1]) in
       ('van','von','de','del','della','di','da','dos','du','la','le','bin','binti','ibn','al','mac','mc')
  then
    return array[
      array_to_string(parts[1:n_parts - 2], ' '),
      parts[n_parts - 1] || ' ' || parts[n_parts]
    ];
  end if;

  return array[array_to_string(parts[1:n_parts - 1], ' '), parts[n_parts]];
end;
$$;

CREATE TABLE attachments (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    message_id integer NOT NULL,
    name text NOT NULL,
    mime text,
    size_bytes integer DEFAULT 0 NOT NULL,
    bytes bytea,
    external_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY attachments ALTER COLUMN bytes SET STORAGE EXTERNAL;

ALTER TABLE attachments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE bot_bases (
    workspace_id integer NOT NULL,
    bot_id integer NOT NULL,
    base_id integer NOT NULL
);

CREATE TABLE bot_calendars (
    workspace_id integer NOT NULL,
    bot_id integer NOT NULL,
    calendar_id integer NOT NULL
);

CREATE TABLE bot_channels (
    workspace_id integer NOT NULL,
    bot_id integer NOT NULL,
    channel text NOT NULL,
    connection_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE bot_resources (
    workspace_id integer NOT NULL,
    bot_id integer NOT NULL,
    resource_id integer NOT NULL
);

CREATE TABLE bots (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text DEFAULT 'Arlo'::text NOT NULL,
    persona text DEFAULT ''::text NOT NULL,
    base_prompt text DEFAULT ''::text NOT NULL,
    model text,
    confidence_floor numeric(3,2) DEFAULT 0.45 NOT NULL,
    strict_kb boolean DEFAULT true NOT NULL,
    escalate text DEFAULT ''::text NOT NULL,
    forbidden text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    business_notes text DEFAULT ''::text NOT NULL,
    memory text DEFAULT ''::text NOT NULL,
    mode text DEFAULT 'live'::text NOT NULL,
    learns boolean DEFAULT true NOT NULL
);

ALTER TABLE bots ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME bots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE calendar_log (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    calendar_id integer NOT NULL,
    event_id integer,
    action text NOT NULL,
    title text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'person'::text NOT NULL,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE calendar_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME calendar_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE calendars (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    colour text DEFAULT 'moss'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE calendars ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME calendars_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE chunks (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    document_id integer NOT NULL,
    ord integer NOT NULL,
    text text NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED,
    embedding public.vector(1536)
);

ALTER TABLE chunks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE connector_configs (
    workspace_id integer NOT NULL,
    provider text NOT NULL,
    config_enc text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE contact_log (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    customer_id integer NOT NULL,
    action text NOT NULL,
    field text,
    was text,
    became text,
    source text DEFAULT 'person'::text NOT NULL,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE contact_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME contact_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE conversations (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    customer_id integer NOT NULL,
    channel text NOT NULL,
    channel_ref text NOT NULL,
    subject text,
    status text DEFAULT 'bot'::text NOT NULL,
    assignee text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_at timestamp with time zone DEFAULT now() NOT NULL,
    bot_id integer,
    harvested_at timestamp with time zone,
    harvest_attempts integer DEFAULT 0 NOT NULL,
    judged_at timestamp with time zone,
    imported_at timestamp with time zone
);

ALTER TABLE conversations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME conversations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE customer_dates (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    customer_id integer NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    title text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    start_time time without time zone,
    end_time time without time zone,
    source text DEFAULT 'person'::text NOT NULL,
    conversation_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE customer_dates ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME customer_dates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE customer_identities (
    workspace_id integer NOT NULL,
    customer_id integer NOT NULL,
    channel text NOT NULL,
    external_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE customer_points (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    customer_id integer NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    label text,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE customer_points ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME customer_points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE customers (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text,
    email text,
    phone text,
    traits jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    first_name text,
    last_name text,
    company text,
    job_title text,
    gender text,
    date_of_birth date,
    nationality text,
    ethnicity text,
    language text,
    timezone text,
    address text,
    city text,
    country text,
    owner text,
    source text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    notes text,
    marketing_consent boolean DEFAULT false NOT NULL,
    do_not_contact boolean DEFAULT false NOT NULL,
    summary text,
    summary_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary_at timestamp with time zone,
    summary_through integer
);

ALTER TABLE customers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME customers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE documents (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    source text NOT NULL,
    uri text,
    title text NOT NULL,
    mime text,
    text text NOT NULL,
    hash text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    site_id integer,
    base_id integer NOT NULL
);

ALTER TABLE documents ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE events (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    title text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    repeats text DEFAULT 'once'::text NOT NULL,
    source text DEFAULT 'person'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    calendar_id integer
);

ALTER TABLE events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE knowledge_bases (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE knowledge_bases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME knowledge_bases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE lesson_resources (
    lesson_id integer NOT NULL,
    resource_id integer NOT NULL,
    workspace_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE lessons (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    bot_id integer NOT NULL,
    conversation_id integer,
    kind text NOT NULL,
    question text,
    answer text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    embedding public.vector(1536),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(question, ''::text) || ' '::text) || answer))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    customer_id integer,
    field text
);

ALTER TABLE lessons ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME lessons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE llm_usage (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    provider text NOT NULL,
    prompt_tokens integer NOT NULL,
    completion_tokens integer NOT NULL,
    total_tokens integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose text,
    conversation_id integer,
    model text
);

ALTER TABLE llm_usage ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME llm_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE mailboxes (
    id text NOT NULL,
    workspace_id integer NOT NULL,
    provider text NOT NULL,
    address text NOT NULL,
    refresh_enc text NOT NULL,
    since timestamp with time zone DEFAULT now() NOT NULL,
    last_sync timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE memberships (
    user_id integer NOT NULL,
    workspace_id integer NOT NULL,
    role text DEFAULT 'member'::text NOT NULL
);

CREATE TABLE messages (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    conversation_id integer NOT NULL,
    direction text NOT NULL,
    author text,
    body text NOT NULL,
    media_type text,
    external_id text,
    cited jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reply_ref text,
    speaker text
);

ALTER TABLE messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE oauth_state (
    state_hash text NOT NULL,
    provider text NOT NULL,
    workspace_id integer NOT NULL,
    verifier text,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE products (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    sku text,
    price numeric(14,2),
    currency text DEFAULT 'SGD'::text NOT NULL,
    unit text,
    active boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE products ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE rate_limits (
    key text NOT NULL,
    hits integer NOT NULL,
    until_ms bigint NOT NULL
);

CREATE TABLE resources (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    url text,
    mime text,
    bytes bytea,
    size_bytes integer DEFAULT 0 NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
WITH (autovacuum_vacuum_threshold='1', autovacuum_vacuum_scale_factor='0', toast.autovacuum_vacuum_threshold='1', toast.autovacuum_vacuum_scale_factor='0');

ALTER TABLE resources ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME resources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE sessions (
    token text NOT NULL,
    user_id integer NOT NULL,
    workspace_id integer NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE sites (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    root_url text NOT NULL,
    follow boolean DEFAULT true NOT NULL,
    max_pages integer DEFAULT 25 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    pages_done integer DEFAULT 0 NOT NULL,
    pages_queued integer DEFAULT 0 NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    error text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failures jsonb DEFAULT '[]'::jsonb NOT NULL,
    base_id integer NOT NULL,
    attempts integer DEFAULT 0 NOT NULL
);

ALTER TABLE sites ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME sites_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE telegram_bots (
    id text NOT NULL,
    workspace_id integer NOT NULL,
    label text NOT NULL,
    token_enc text NOT NULL,
    secret text NOT NULL,
    allowed jsonb DEFAULT '[]'::jsonb NOT NULL,
    pending jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    username text
);

CREATE TABLE uploads (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    filename text NOT NULL,
    mime text,
    bytes bytea NOT NULL,
    size_bytes integer NOT NULL,
    sha text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    document_id integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    base_id integer NOT NULL,
    pages_done integer DEFAULT 0 NOT NULL,
    pages_total integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL
)
WITH (autovacuum_vacuum_threshold='1', autovacuum_vacuum_scale_factor='0', toast.autovacuum_vacuum_threshold='1', toast.autovacuum_vacuum_scale_factor='0');

ALTER TABLE uploads ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME uploads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE users (
    id integer NOT NULL,
    email text NOT NULL,
    password_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_user_id uuid
);

ALTER TABLE users ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE web_widgets (
    id text NOT NULL,
    workspace_id integer NOT NULL,
    label text NOT NULL,
    key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workspaces (
    id integer NOT NULL,
    name text NOT NULL,
    ingest_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    identity text,
    identity_at timestamp with time zone,
    identity_manual boolean DEFAULT false NOT NULL,
    llm_provider text DEFAULT 'default'::text NOT NULL,
    autobricks_key_enc text
);

ALTER TABLE workspaces ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME workspaces_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY bot_bases
    ADD CONSTRAINT bot_bases_pkey PRIMARY KEY (bot_id, base_id);

ALTER TABLE ONLY bot_calendars
    ADD CONSTRAINT bot_calendars_pkey PRIMARY KEY (bot_id, calendar_id);

ALTER TABLE ONLY bot_channels
    ADD CONSTRAINT bot_channels_pkey PRIMARY KEY (workspace_id, channel, connection_ref);

ALTER TABLE ONLY bot_resources
    ADD CONSTRAINT bot_resources_pkey PRIMARY KEY (bot_id, resource_id);

ALTER TABLE ONLY bots
    ADD CONSTRAINT bots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY calendar_log
    ADD CONSTRAINT calendar_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY calendars
    ADD CONSTRAINT calendars_pkey PRIMARY KEY (id);

ALTER TABLE ONLY chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connector_configs
    ADD CONSTRAINT connector_configs_pkey PRIMARY KEY (workspace_id, provider);

ALTER TABLE ONLY contact_log
    ADD CONSTRAINT contact_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY customer_dates
    ADD CONSTRAINT customer_dates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY customer_identities
    ADD CONSTRAINT customer_identities_pkey PRIMARY KEY (workspace_id, channel, external_id);

ALTER TABLE ONLY customer_points
    ADD CONSTRAINT customer_points_pkey PRIMARY KEY (id);

ALTER TABLE ONLY customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_bases
    ADD CONSTRAINT knowledge_bases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY lesson_resources
    ADD CONSTRAINT lesson_resources_pkey PRIMARY KEY (lesson_id, resource_id);

ALTER TABLE ONLY lessons
    ADD CONSTRAINT lessons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mailboxes
    ADD CONSTRAINT mailboxes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (user_id, workspace_id);

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY oauth_state
    ADD CONSTRAINT oauth_state_pkey PRIMARY KEY (state_hash);

ALTER TABLE ONLY products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);

ALTER TABLE ONLY resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token);

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY telegram_bots
    ADD CONSTRAINT telegram_bots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY web_widgets
    ADD CONSTRAINT web_widgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

CREATE INDEX attachments_message ON attachments USING btree (workspace_id, message_id);

CREATE INDEX bot_bases_base ON bot_bases USING btree (base_id);

CREATE INDEX bot_calendars_workspace ON bot_calendars USING btree (workspace_id, bot_id);

CREATE INDEX bot_channels_bot ON bot_channels USING btree (bot_id);

CREATE INDEX bot_resources_resource ON bot_resources USING btree (resource_id);

CREATE UNIQUE INDEX bots_one_default ON bots USING btree (workspace_id) WHERE is_default;

CREATE INDEX calendar_log_calendar ON calendar_log USING btree (calendar_id, created_at DESC);

CREATE UNIQUE INDEX calendars_one_default ON calendars USING btree (workspace_id) WHERE is_default;

CREATE INDEX calendars_workspace ON calendars USING btree (workspace_id, "position", id);

CREATE INDEX chunks_document ON chunks USING btree (document_id, ord);

CREATE INDEX chunks_embedding ON chunks USING hnsw (embedding public.vector_cosine_ops);

CREATE INDEX chunks_tsv ON chunks USING gin (tsv);

CREATE INDEX contact_log_customer ON contact_log USING btree (customer_id, created_at DESC);

CREATE INDEX conversations_bot ON conversations USING btree (workspace_id, bot_id, last_at DESC);

CREATE INDEX conversations_customer ON conversations USING btree (customer_id, last_at DESC);

CREATE INDEX conversations_imported ON conversations USING btree (workspace_id, imported_at) WHERE (imported_at IS NOT NULL);

CREATE INDEX conversations_recent ON conversations USING btree (workspace_id, last_at DESC);

CREATE UNIQUE INDEX conversations_thread ON conversations USING btree (workspace_id, channel, channel_ref);

CREATE INDEX conversations_unharvested ON conversations USING btree (workspace_id, last_at) WHERE (harvested_at IS NULL);

CREATE INDEX customer_dates_customer ON customer_dates USING btree (customer_id, starts_on);

CREATE UNIQUE INDEX customer_dates_once ON customer_dates USING btree (customer_id, kind, starts_on, COALESCE(ends_on, starts_on));

CREATE INDEX customer_identities_customer ON customer_identities USING btree (customer_id);

CREATE INDEX customer_points_customer ON customer_points USING btree (workspace_id, customer_id);

CREATE UNIQUE INDEX customer_points_value ON customer_points USING btree (customer_id, kind, lower(value));

CREATE INDEX customers_email ON customers USING btree (workspace_id, lower(email)) WHERE (email IS NOT NULL);

CREATE INDEX customers_workspace ON customers USING btree (workspace_id, last_seen_at DESC);

CREATE INDEX documents_base ON documents USING btree (base_id);

CREATE UNIQUE INDEX documents_hash ON documents USING btree (workspace_id, base_id, hash);

CREATE INDEX documents_site ON documents USING btree (site_id);

CREATE UNIQUE INDEX documents_uri ON documents USING btree (workspace_id, base_id, uri) WHERE (uri IS NOT NULL);

CREATE INDEX events_workspace ON events USING btree (workspace_id, starts_on);

CREATE INDEX knowledge_bases_workspace ON knowledge_bases USING btree (workspace_id, created_at);

CREATE INDEX lesson_resources_lesson ON lesson_resources USING btree (workspace_id, lesson_id);

CREATE INDEX lessons_embedding ON lessons USING hnsw (embedding public.vector_cosine_ops);

CREATE UNIQUE INDEX lessons_one_per_answer ON lessons USING btree (bot_id, kind, md5(lower(answer))) WHERE ((status <> 'rejected'::text) AND (kind <> 'contact'::text));

CREATE UNIQUE INDEX lessons_one_per_contact_field ON lessons USING btree (bot_id, customer_id, field) WHERE ((kind = 'contact'::text) AND (status <> 'rejected'::text));

CREATE INDEX lessons_review ON lessons USING btree (workspace_id, bot_id, status, created_at DESC);

CREATE INDEX lessons_tsv ON lessons USING gin (tsv);

CREATE INDEX llm_usage_conversation ON llm_usage USING btree (workspace_id, conversation_id) WHERE (conversation_id IS NOT NULL);

CREATE INDEX llm_usage_model ON llm_usage USING btree (workspace_id, model, created_at DESC) WHERE (model IS NOT NULL);

CREATE INDEX llm_usage_workspace ON llm_usage USING btree (workspace_id, created_at DESC);

CREATE UNIQUE INDEX mailboxes_address ON mailboxes USING btree (workspace_id, provider, lower(address));

CREATE UNIQUE INDEX messages_external ON messages USING btree (workspace_id, external_id) WHERE (external_id IS NOT NULL);

CREATE INDEX messages_thread ON messages USING btree (conversation_id, created_at);

CREATE INDEX products_workspace ON products USING btree (workspace_id, "position", id);

CREATE UNIQUE INDEX resources_token ON resources USING btree (token);

CREATE INDEX resources_workspace ON resources USING btree (workspace_id, created_at DESC);

CREATE INDEX sessions_expiry ON sessions USING btree (expires_at);

CREATE INDEX sites_base ON sites USING btree (base_id);

CREATE UNIQUE INDEX sites_root ON sites USING btree (workspace_id, base_id, root_url);

CREATE INDEX sites_workspace ON sites USING btree (workspace_id, created_at DESC);

CREATE INDEX telegram_bots_workspace ON telegram_bots USING btree (workspace_id);

CREATE INDEX uploads_base ON uploads USING btree (base_id);

CREATE INDEX uploads_document ON uploads USING btree (document_id);

CREATE UNIQUE INDEX uploads_sha ON uploads USING btree (workspace_id, base_id, sha);

CREATE INDEX uploads_workspace ON uploads USING btree (workspace_id, created_at DESC);

CREATE UNIQUE INDEX users_auth_user_id ON users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX users_email ON users USING btree (lower(email));

CREATE UNIQUE INDEX web_widgets_key ON web_widgets USING btree (key);

CREATE INDEX web_widgets_workspace ON web_widgets USING btree (workspace_id);

CREATE UNIQUE INDEX workspaces_token ON workspaces USING btree (ingest_token);

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_bases
    ADD CONSTRAINT bot_bases_base_id_fkey FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_bases
    ADD CONSTRAINT bot_bases_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_bases
    ADD CONSTRAINT bot_bases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_calendars
    ADD CONSTRAINT bot_calendars_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_calendars
    ADD CONSTRAINT bot_calendars_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_calendars
    ADD CONSTRAINT bot_calendars_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_channels
    ADD CONSTRAINT bot_channels_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_channels
    ADD CONSTRAINT bot_channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_resources
    ADD CONSTRAINT bot_resources_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_resources
    ADD CONSTRAINT bot_resources_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY bot_resources
    ADD CONSTRAINT bot_resources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY bots
    ADD CONSTRAINT bots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY calendar_log
    ADD CONSTRAINT calendar_log_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE;

ALTER TABLE ONLY calendar_log
    ADD CONSTRAINT calendar_log_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;

ALTER TABLE ONLY calendar_log
    ADD CONSTRAINT calendar_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY calendars
    ADD CONSTRAINT calendars_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY chunks
    ADD CONSTRAINT chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY chunks
    ADD CONSTRAINT chunks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_configs
    ADD CONSTRAINT connector_configs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY contact_log
    ADD CONSTRAINT contact_log_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY contact_log
    ADD CONSTRAINT contact_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL;

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_dates
    ADD CONSTRAINT customer_dates_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

ALTER TABLE ONLY customer_dates
    ADD CONSTRAINT customer_dates_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_dates
    ADD CONSTRAINT customer_dates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_identities
    ADD CONSTRAINT customer_identities_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_identities
    ADD CONSTRAINT customer_identities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_points
    ADD CONSTRAINT customer_points_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY customer_points
    ADD CONSTRAINT customer_points_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY customers
    ADD CONSTRAINT customers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_base_id_fkey FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_site_id_fkey FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY events
    ADD CONSTRAINT events_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE;

ALTER TABLE ONLY events
    ADD CONSTRAINT events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_bases
    ADD CONSTRAINT knowledge_bases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY lesson_resources
    ADD CONSTRAINT lesson_resources_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE;

ALTER TABLE ONLY lesson_resources
    ADD CONSTRAINT lesson_resources_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY lesson_resources
    ADD CONSTRAINT lesson_resources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY lessons
    ADD CONSTRAINT lessons_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE;

ALTER TABLE ONLY lessons
    ADD CONSTRAINT lessons_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

ALTER TABLE ONLY lessons
    ADD CONSTRAINT lessons_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY lessons
    ADD CONSTRAINT lessons_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY llm_usage
    ADD CONSTRAINT llm_usage_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

ALTER TABLE ONLY llm_usage
    ADD CONSTRAINT llm_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mailboxes
    ADD CONSTRAINT mailboxes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY oauth_state
    ADD CONSTRAINT oauth_state_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY products
    ADD CONSTRAINT products_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY resources
    ADD CONSTRAINT resources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_base_id_fkey FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY telegram_bots
    ADD CONSTRAINT telegram_bots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_base_id_fkey FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY web_widgets
    ADD CONSTRAINT web_widgets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

ALTER TABLE bot_bases ENABLE ROW LEVEL SECURITY;

ALTER TABLE bot_calendars ENABLE ROW LEVEL SECURITY;

ALTER TABLE bot_channels ENABLE ROW LEVEL SECURITY;

ALTER TABLE bot_resources ENABLE ROW LEVEL SECURITY;

ALTER TABLE bots ENABLE ROW LEVEL SECURITY;

ALTER TABLE calendar_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

ALTER TABLE connector_configs ENABLE ROW LEVEL SECURITY;

ALTER TABLE contact_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE customer_dates ENABLE ROW LEVEL SECURITY;

ALTER TABLE customer_identities ENABLE ROW LEVEL SECURITY;

ALTER TABLE customer_points ENABLE ROW LEVEL SECURITY;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;

ALTER TABLE lesson_resources ENABLE ROW LEVEL SECURITY;

ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;

ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;

ALTER TABLE telegram_bots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON attachments FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON bot_bases FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON bot_calendars FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON bot_channels FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON bot_resources FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON bots FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON calendar_log FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON calendars FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON chunks FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON connector_configs FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON contact_log FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON conversations FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON customer_dates FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON customer_identities FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON customer_points FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON customers FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON documents FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON events FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON knowledge_bases FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON lesson_resources FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON lessons FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON llm_usage FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON mailboxes FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON messages FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON products FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON resources FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON sites FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON telegram_bots FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON uploads FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_read ON web_widgets FOR SELECT USING ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON attachments USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON bot_bases USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON bot_calendars USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON bot_channels USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON bot_resources USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON bots USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON calendar_log USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON calendars USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON chunks USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON connector_configs USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON contact_log USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON conversations USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON customer_dates USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON customer_identities USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON customer_points USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON customers USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON documents USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON events USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON knowledge_bases USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON lesson_resources USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON lessons USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON llm_usage USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON mailboxes USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON messages USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON products USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON resources USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON sites USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON telegram_bots USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON uploads USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

CREATE POLICY tenant_write ON web_widgets USING ((workspace_id = app_workspace())) WITH CHECK ((workspace_id = app_workspace()));

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;

ALTER TABLE web_widgets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- grants
--
-- The app role reads and writes rows. DDL stays with the owner, which runs migrations.
--
-- `alter default privileges` applies to objects created after it, so a table added by a
-- later migration is covered without anybody coming back for it. Against current_schema()
-- because the tests migrate into a schema of their own.
do $$
declare s text := current_schema();
begin
  execute format('grant usage on schema %I to arlo_app', s);
  execute format('grant select, insert, update, delete on all tables in schema %I to arlo_app', s);
  execute format('grant usage, select on all sequences in schema %I to arlo_app', s);

  execute format(
    'alter default privileges in schema %I grant select, insert, update, delete on tables to arlo_app', s);
  execute format(
    'alter default privileges in schema %I grant usage, select on sequences to arlo_app', s);
end $$;

-- The helper every policy calls.
grant execute on function app_workspace() to arlo_app;
