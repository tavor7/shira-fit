-- Late-cancel studio fee defaults to waived (manager opts in). Legacy rows were auto-marked charged
-- with no collection; reset those so the UI default is “waive”.

update public.cancellations
set charged_full_price = false
where charged_full_price is true
  and coalesce(penalty_collected_ils, 0) = 0;
