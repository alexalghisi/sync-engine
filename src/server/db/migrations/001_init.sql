create table workspaces (
    id uuid primary key,
    name text not null,
    created_at timestamptz not null default now()
);

create table teams (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    key text not null,
    name text not null,
    unique (workspace_id, key)
);

create table users (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    name text not null
);

create table issues (
    id uuid primary key,
    -- Denormalised from the team so every sync query can filter on one indexed column.
    workspace_id uuid not null references workspaces (id) on delete cascade,
    team_id uuid not null references teams (id) on delete cascade,
    title text not null check (char_length(title) between 1 and 512),
    description text not null default '',
    status text not null check (status in ('backlog', 'todo', 'in_progress', 'done', 'canceled')),
    priority smallint not null check (priority between 0 and 4),
    assignee_id uuid references users (id),
    sort_order double precision not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz
);

create index issues_workspace_idx on issues (workspace_id);

create type sync_action_kind as enum ('insert', 'update', 'archive', 'delete');

-- Append-only log of every change. Clients hold the highest sync_id they have applied
-- and ask for everything after it when they reconnect.
create table sync_actions (
    sync_id bigserial primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    model text not null,
    model_id uuid not null,
    action sync_action_kind not null,
    data jsonb not null,
    tx_id uuid,
    created_at timestamptz not null default now()
);

create index sync_actions_workspace_sync_idx on sync_actions (workspace_id, sync_id);

-- Makes client transactions idempotent: a client that never saw its ack resends, and
-- gets the original result back instead of applying the change twice.
create table applied_transactions (
    tx_id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    last_sync_id bigint not null,
    created_at timestamptz not null default now()
);

create table sync_log_compaction (
    workspace_id uuid primary key references workspaces (id) on delete cascade,
    compacted_through bigint not null
);
