-- Security Advisor rls_disabled_in_public (2026-11-14): public."_" (user_id uuid)
-- is a stray table, most likely left by an ad-hoc plain-SQL `select ... into _`.
-- No migration, function, view or client code references it, it has never held
-- rows, and anon/authenticated had full grants on it with RLS off. Drop it rather
-- than add policies. Aborts if it ever gained rows; no CASCADE, so any dependent
-- object also aborts the drop.
do $$
begin
  if to_regclass('public."_"') is not null
     and exists (select 1 from public."_") then
    raise exception 'public."_" is not empty; refusing to drop';
  end if;
end $$;

drop table if exists public."_";
