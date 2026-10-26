insert into public.sensors
  (mode, owner_id, name, location_note, mount_height_cm, alert_depth_cm, is_simulated)
select 'personal', u.id, 'Basement (demo unit)', 'Simulated readings for demonstrations', 80, 2, true
from auth.users u
where u.email = 'niralnishantparmar+home@gmail.com'
  and not exists (select 1 from public.sensors s where s.owner_id = u.id and s.is_simulated);
