create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'resident' check (role in ('resident', 'official')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_official()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'official'
  );
$$;

create table public.sensors (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('street', 'personal')),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  location_note text,
  lat double precision,
  lng double precision,
  mount_height_cm real not null default 100,
  alert_depth_cm real not null default 5,
  is_simulated boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.sensors enable row level security;

create policy "street sensors are public"
  on public.sensors for select to anon, authenticated
  using (mode = 'street');

create policy "owners see their own sensors"
  on public.sensors for select to authenticated
  using (owner_id = auth.uid());

create policy "officials add street sensors"
  on public.sensors for insert to authenticated
  with check (mode = 'street' and owner_id = auth.uid() and public.is_official());

create policy "residents add personal sensors"
  on public.sensors for insert to authenticated
  with check (mode = 'personal' and owner_id = auth.uid());

create policy "owners edit their sensors"
  on public.sensors for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and (mode = 'personal' or public.is_official()));

create policy "owners remove their sensors"
  on public.sensors for delete to authenticated
  using (owner_id = auth.uid());

create table public.sensor_keys (
  sensor_id uuid primary key references public.sensors(id) on delete cascade,
  device_key text not null unique default replace(gen_random_uuid()::text, '-', '')
);

alter table public.sensor_keys enable row level security;

create policy "owners see their device keys"
  on public.sensor_keys for select to authenticated
  using (exists (
    select 1 from public.sensors s
    where s.id = sensor_id and s.owner_id = auth.uid()
  ));

create or replace function public.create_sensor_key()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.sensor_keys (sensor_id) values (new.id);
  return new;
end;
$$;

create trigger on_sensor_created
  after insert on public.sensors
  for each row execute procedure public.create_sensor_key();

create table public.readings (
  id bigint generated always as identity primary key,
  sensor_id uuid not null references public.sensors(id) on delete cascade,
  created_at timestamptz not null default now(),
  distance_mm integer,
  water_cm real,
  rise_cm_per_min real,
  temp_c real,
  battery_v real,
  battery_pct real
);

create index readings_sensor_time on public.readings (sensor_id, created_at desc);

alter table public.readings enable row level security;

create policy "readings follow sensor visibility"
  on public.readings for select to anon, authenticated
  using (exists (select 1 from public.sensors s where s.id = sensor_id));

create or replace function public.submit_reading(
  p_device_key text,
  p_distance_mm integer,
  p_rise_cm_per_min real default null,
  p_temp_c real default null,
  p_battery_v real default null,
  p_battery_pct real default null
)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_sensor uuid;
  v_mount real;
begin
  select k.sensor_id, s.mount_height_cm
    into v_sensor, v_mount
  from public.sensor_keys k
  join public.sensors s on s.id = k.sensor_id
  where k.device_key = p_device_key;

  if v_sensor is null then
    raise exception 'unknown device key';
  end if;

  insert into public.readings
    (sensor_id, distance_mm, water_cm, rise_cm_per_min, temp_c, battery_v, battery_pct)
  values
    (v_sensor, p_distance_mm, greatest(0, v_mount - p_distance_mm / 10.0),
     p_rise_cm_per_min, p_temp_c, p_battery_v, p_battery_pct);
end;
$$;

create table public.reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '4 hours',
  lat double precision not null,
  lng double precision not null,
  kind text not null check (kind in ('flooded_road', 'blocked_drain', 'stalled_car', 'other')),
  note text check (char_length(note) <= 280),
  reporter_id uuid references auth.users(id) on delete set null
);

alter table public.reports enable row level security;

create policy "active reports are public"
  on public.reports for select to anon, authenticated
  using (expires_at > now());

create policy "anyone can file a report"
  on public.reports for insert to anon, authenticated
  with check (
    expires_at <= now() + interval '12 hours'
    and (reporter_id is null or reporter_id = auth.uid())
  );

grant usage on schema public to anon, authenticated;
grant select on public.sensors, public.readings, public.reports to anon, authenticated;
grant insert, update, delete on public.sensors to authenticated;
grant insert on public.reports to anon, authenticated;
grant select on public.profiles, public.sensor_keys to authenticated;
grant usage on all sequences in schema public to anon, authenticated;

revoke execute on function public.submit_reading(text, integer, real, real, real, real) from public;
grant execute on function public.submit_reading(text, integer, real, real, real, real) to anon, authenticated;
grant execute on function public.is_official() to anon, authenticated;

alter publication supabase_realtime add table public.readings, public.reports;


create table public.devices (
  device_key text primary key,
  pairing_code text not null unique,
  firmware text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sensor_id uuid references public.sensors(id) on delete set null
);

alter table public.devices enable row level security;

create or replace function public.register_device(p_device_key text, p_pairing_code text, p_firmware text default null)
returns json
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code text := upper(replace(coalesce(p_pairing_code, ''), '-', ''));
  v_sensor uuid;
begin
  if length(coalesce(p_device_key, '')) < 24 or v_code !~ '^[A-Z0-9]{6}$' then
    raise exception 'invalid device registration';
  end if;
  begin
    insert into public.devices (device_key, pairing_code, firmware)
    values (p_device_key, v_code, p_firmware)
    on conflict (device_key) do update
      set last_seen_at = now(), firmware = excluded.firmware, pairing_code = excluded.pairing_code;
  exception when unique_violation then
    return json_build_object('paired', false, 'error', 'code_taken');
  end;
  select sensor_id into v_sensor from public.devices where device_key = p_device_key;
  return json_build_object('paired', v_sensor is not null);
end;
$$;

create or replace function public.claim_device(
  p_pairing_code text,
  p_mode text,
  p_name text,
  p_location_note text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_alert_depth_cm real default null
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_code text := upper(replace(trim(coalesce(p_pairing_code, '')), '-', ''));
  v_device text;
  v_sensor uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before adding a sensor.';
  end if;
  if p_mode not in ('street', 'personal') then
    raise exception 'Unknown sensor type.';
  end if;
  if p_mode = 'street' and not public.is_official() then
    raise exception 'Street sensors need a verified municipal account.';
  end if;
  if p_mode = 'street' and (p_lat is null or p_lng is null) then
    raise exception 'Choose where the sensor is mounted on the map.';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Give the sensor a name.';
  end if;
  select device_key into v_device
  from public.devices
  where pairing_code = v_code and sensor_id is null
  for update;
  if v_device is null then
    raise exception 'No sensor is waiting with that pairing code.';
  end if;
  insert into public.sensors (mode, owner_id, name, location_note, lat, lng, alert_depth_cm)
  values (
    p_mode, auth.uid(), trim(p_name), nullif(trim(coalesce(p_location_note, '')), ''), p_lat, p_lng,
    coalesce(p_alert_depth_cm, case when p_mode = 'street' then 15.24 else 2.54 end)
  )
  returning id into v_sensor;
  update public.sensor_keys set device_key = v_device where sensor_id = v_sensor;
  update public.devices set sensor_id = v_sensor where device_key = v_device;
  return v_sensor;
end;
$$;

create or replace function public.submit_reading(
  p_device_key text,
  p_distance_mm integer,
  p_rise_cm_per_min real default null,
  p_temp_c real default null,
  p_battery_v real default null,
  p_battery_pct real default null
)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_sensor uuid;
  v_mount real;
begin
  update public.devices set last_seen_at = now() where device_key = p_device_key;
  select k.sensor_id, s.mount_height_cm
    into v_sensor, v_mount
  from public.sensor_keys k
  join public.sensors s on s.id = k.sensor_id
  where k.device_key = p_device_key;
  if v_sensor is null then
    if exists (select 1 from public.devices where device_key = p_device_key) then
      raise exception 'device not paired';
    end if;
    raise exception 'unknown device key';
  end if;
  insert into public.readings
    (sensor_id, distance_mm, water_cm, rise_cm_per_min, temp_c, battery_v, battery_pct)
  values
    (v_sensor, p_distance_mm, greatest(0, v_mount - p_distance_mm / 10.0),
     p_rise_cm_per_min, p_temp_c, p_battery_v, p_battery_pct);
end;
$$;

alter table public.reports add column if not exists clears integer not null default 0;

create table public.report_tokens (
  report_id bigint primary key references public.reports(id) on delete cascade,
  token text not null
);
create index report_tokens_token on public.report_tokens (token);
alter table public.report_tokens enable row level security;

create table public.report_clears (
  report_id bigint not null references public.reports(id) on delete cascade,
  voter text not null,
  created_at timestamptz not null default now(),
  primary key (report_id, voter)
);
alter table public.report_clears enable row level security;

drop policy if exists "anyone can file a report" on public.reports;
revoke insert on public.reports from anon, authenticated;

create or replace function public.file_report(
  p_lat double precision,
  p_lng double precision,
  p_kind text,
  p_note text,
  p_token text
)
returns public.reports
language plpgsql
security definer set search_path = ''
as $$
declare
  v_row public.reports;
  v_recent integer;
begin
  if length(coalesce(p_token, '')) < 16 then
    raise exception 'Missing report token.';
  end if;
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'That location is not valid.';
  end if;
  select count(*) into v_recent
  from public.reports r
  join public.report_tokens t on t.report_id = r.id
  where t.token = p_token and r.created_at > now() - interval '1 hour';
  if v_recent >= 5 then
    raise exception 'You have sent several reports in the last hour. Please wait a bit before sending another.';
  end if;
  insert into public.reports (lat, lng, kind, note, reporter_id)
  values (p_lat, p_lng, p_kind, nullif(left(trim(coalesce(p_note, '')), 280), ''), auth.uid())
  returning * into v_row;
  insert into public.report_tokens (report_id, token) values (v_row.id, p_token);
  return v_row;
end;
$$;

create or replace function public.delete_report(p_id bigint, p_token text default null)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
begin
  delete from public.reports r
  where r.id = p_id
    and (
      exists (select 1 from public.report_tokens t where t.report_id = r.id and t.token = p_token)
      or (auth.uid() is not null and r.reporter_id = auth.uid())
      or public.is_official()
    );
  return found;
end;
$$;

create or replace function public.clear_report(p_id bigint, p_voter text)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  v_clears integer;
begin
  if length(coalesce(p_voter, '')) < 16 then
    raise exception 'Missing voter token.';
  end if;
  insert into public.report_clears (report_id, voter) values (p_id, p_voter) on conflict do nothing;
  if found then
    update public.reports
      set clears = clears + 1,
          expires_at = case when clears + 1 >= 2 then now() else expires_at end
      where id = p_id
      returning clears into v_clears;
  else
    select clears into v_clears from public.reports where id = p_id;
  end if;
  return coalesce(v_clears, 0);
end;
$$;

revoke execute on function public.register_device(text, text, text) from public;
revoke execute on function public.claim_device(text, text, text, text, double precision, double precision, real) from public;
revoke execute on function public.file_report(double precision, double precision, text, text, text) from public;
revoke execute on function public.delete_report(bigint, text) from public;
revoke execute on function public.clear_report(bigint, text) from public;
grant execute on function public.register_device(text, text, text) to anon, authenticated;
grant execute on function public.claim_device(text, text, text, text, double precision, double precision, real) to authenticated;
grant execute on function public.file_report(double precision, double precision, text, text, text) to anon, authenticated;
grant execute on function public.delete_report(bigint, text) to anon, authenticated;
grant execute on function public.clear_report(bigint, text) to anon, authenticated;

create or replace function public.check_pairing_code(p_pairing_code text)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.devices
    where pairing_code = upper(replace(trim(coalesce(p_pairing_code, '')), '-', ''))
      and sensor_id is null
      and last_seen_at > now() - interval '1 day'
  );
$$;

revoke execute on function public.check_pairing_code(text) from public;
grant execute on function public.check_pairing_code(text) to authenticated;
