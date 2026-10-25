-- FloodMesh database setup
-- Run once: Supabase dashboard > SQL Editor > New query > paste all of this > Run


-- Accounts --------------------------------------------------------------

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

-- No update policy on purpose: nobody can promote themselves to official.
-- Officials are approved by an admin running the update in step 5 of the setup.

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


-- Sensors ---------------------------------------------------------------
-- street   = installed by a verified official, shown on the public map
-- personal = bought by a resident for a basement etc., private to the owner

create table public.sensors (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('street', 'personal')),
  owner_id uuid references auth.users(id) on delete cascade,
  name text not null,
  location_note text,
  lat double precision,
  lng double precision,
  mount_height_cm real not null default 100,  -- sensor face to dry ground / floor
  alert_depth_cm real not null default 5,     -- water depth that counts as flooding
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


-- Device keys -----------------------------------------------------------
-- Kept in a separate table so the public map never exposes them.
-- Each physical sensor gets one; it goes into the firmware.

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


-- Readings --------------------------------------------------------------

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

-- Devices don't write to the table directly. They call this function with their
-- device key, and the water depth is worked out here from the mount height, so a
-- sensor can be recalibrated from the app without reflashing it.
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


-- Community reports -----------------------------------------------------

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


-- Permissions and live updates ------------------------------------------

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
