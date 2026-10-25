-- FloodMesh starting data
-- Run once after schema.sql: SQL Editor > New query > paste > Run

-- Street sensors, owned by the verified municipal account.
-- Mt. Pleasant Ave is the physical prototype. The two school sites are simulated.
insert into public.sensors
  (mode, owner_id, name, location_note, lat, lng, mount_height_cm, alert_depth_cm, is_simulated)
select 'street', u.id, v.name, v.note, v.lat, v.lng, v.mount, v.alert, v.sim
from auth.users u
cross join (values
  ('Mt. Pleasant Ave',          'Bottom of the hill, near 45-59 Mt. Pleasant Ave', 40.5759977, -74.3672054, 110::real, 15::real, false),
  ('J.P. Stevens High School',  '855 Grove Ave',                                   40.580263,  -74.36070,   120::real, 15::real, true),
  ('John Adams Middle School',  '1081 New Dover Rd',                               40.579028,  -74.369306,  120::real, 15::real, true)
) as v(name, note, lat, lng, mount, alert, sim)
where u.email = 'niralnishantparmar+official@gmail.com';

-- A simulated basement sensor for the homeowner demo account.
insert into public.sensors
  (mode, owner_id, name, location_note, mount_height_cm, alert_depth_cm, is_simulated)
select 'personal', u.id, 'Basement', 'Next to the water heater', 80, 2, true
from auth.users u
where u.email = 'niralnishantparmar+home@gmail.com';

-- Check: should list 4 sensors. Copy the Mt. Pleasant Ave device_key into the firmware.
select s.name, s.mode, s.is_simulated, k.device_key
from public.sensors s
join public.sensor_keys k on k.sensor_id = s.id
order by s.mode desc, s.name;
