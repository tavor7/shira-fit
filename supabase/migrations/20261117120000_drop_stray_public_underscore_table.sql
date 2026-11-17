-- Security Advisor rls_disabled_in_public (2026-11-14): public."_" (user_id uuid)
-- is a stray table, most likely left by an ad-hoc plain-SQL `select ... into _`.
-- No migration, function, view or client code references it, it has never held
-- rows, and anon/authenticated had full grants on it with RLS off. Drop it rather
-- than add policies. Aborts if it ever gained rows; no CASCADE, so any dependent
-- object also aborts the drop.
do $$
declare
  has_rows boolean;
begin
  -- Dynamic SQL: a static reference fails on fresh databases where the table never existed.
  if to_regclass('public."_"') is not null then
    execute 'select exists (select 1 from public."_")' into has_rows;
    if has_rows then
      raise exception 'public."_" is not empty; refusing to drop';
    end if;
  end if;
end $$;

drop table if exists public."_";
