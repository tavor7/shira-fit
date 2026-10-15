### chromium: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3354 | 2660 | 1751 | -1603 (-48%) | -909 (-34%) |
| athlete | Cold start: home mounts at (ms) | 1554 | 1428 | 572 | -982 (-63%) | -856 (-60%) |
| athlete | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| athlete | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| athlete | Cold start: home requests before content | 34 | 29 | 27 | -7 (-21%) | -2 (-7%) |
| athlete | Cold start: home depth before content | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| athlete | Cold start: all requests (network) | 40 | 35 | 29 | -11 (-28%) | -6 (-17%) |
| athlete | Open detail: tap→content (ms) | 1317 | 1047 | 1066 | -251 (-19%) | +19 (+2%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 5 | -1 (-17%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2060 | 1529 | 1540 | -520 (-25%) | +11 (+1%) |
| athlete | Back: content hidden (ms) | 1752 | 1182 | 1175 | -577 (-33%) | -7 (-1%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| athlete | Resume: requests in 5 s | 12 | 12 | 8 | -4 (-33%) | -4 (-33%) |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| athlete | rest:profiles requests: coldStart | 5 | 5 | 2 | -3 (-60%) | -3 (-60%) |
| athlete | rest:profiles requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| athlete | rest:profiles requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| athlete | rpc:get_required_consents requests: coldStart | 3 | 3 | 3 | 0 (0%) | 0 (0%) |
| athlete | rpc:get_required_consents requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| athlete | rpc:get_required_consents requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| coach | Cold start: content since navigation start (ms) | 2807 | 2825 | 1983 | -824 (-29%) | -842 (-30%) |
| coach | Cold start: home mounts at (ms) | 1420 | 1431 | 589 | -831 (-59%) | -842 (-59%) |
| coach | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| coach | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| coach | Cold start: home requests before content | 35 | 35 | 34 | -1 (-3%) | -1 (-3%) |
| coach | Cold start: home depth before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 42 | 37 | -5 (-12%) | -5 (-12%) |
| coach | Open detail: tap→content (ms) | 518 | 252 | 258 | -260 (-50%) | +6 (+2%) |
| coach | Open detail: requests before content | 10 | 7 | 8 | -2 (-20%) | +1 (+14%) |
| coach | Open detail: depth before content | 3 | 1 | 2 | -1 (-33%) | +1 (+100%) |
| coach | Open detail: settled (ms) | 1461 | 1502 | 1498 | +37 (+3%) | -4 (0%) |
| coach | Back: content hidden (ms) | 1325 | 1365 | 1348 | +23 (+2%) | -17 (-1%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 7 | 7 | 0 (0%) | 0 (0%) |
| coach | Resume: requests in 5 s | 12 | 12 | 8 | -4 (-33%) | -4 (-33%) |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| coach | rest:profiles requests: coldStart | 9 | 9 | 6 | -3 (-33%) | -3 (-33%) |
| coach | rest:profiles requests: openDetail | 1 | 1 | 1 | 0 (0%) | 0 (0%) |
| coach | rest:profiles requests: backToHome | 3 | 3 | 3 | 0 (0%) | 0 (0%) |
| coach | rpc:get_required_consents requests: coldStart | 3 | 3 | 3 | 0 (0%) | 0 (0%) |
| coach | rpc:get_required_consents requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| coach | rpc:get_required_consents requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 2815 | 2879 | 1927 | -888 (-32%) | -952 (-33%) |
| manager | Cold start: home mounts at (ms) | 1385 | 1399 | 562 | -823 (-59%) | -837 (-60%) |
| manager | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| manager | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| manager | Cold start: home requests before content | 36 | 36 | 34 | -2 (-6%) | -2 (-6%) |
| manager | Cold start: home depth before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Cold start: all requests (network) | 42 | 42 | 36 | -6 (-14%) | -6 (-14%) |
| manager | Open detail: tap→content (ms) | 249 | 252 | 247 | -2 (-1%) | -5 (-2%) |
| manager | Open detail: requests before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 420 | 418 | 417 | -3 (-1%) | -1 (0%) |
| manager | Roster: focus→content (ms) | 1264 | 1257 | 1268 | +4 (+0%) | +11 (+1%) |
| manager | Back: content hidden (ms) | 1347 | 1338 | 1352 | +5 (+0%) | +14 (+1%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 7 | 7 | 0 (0%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1494 | 1412 | 1372 | -122 (-8%) | -40 (-3%) |
| manager | Dashboard → Global: click→content (ms) | 1704 | 1705 | 1747 | +43 (+3%) | +42 (+2%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1366 | 1313 | 1352 | -14 (-1%) | +39 (+3%) |
| manager | Resume: requests in 5 s | 12 | 12 | 8 | -4 (-33%) | -4 (-33%) |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | rest:profiles requests: coldStart | 10 | 10 | 7 | -3 (-30%) | -3 (-30%) |
| manager | rest:profiles requests: openDetail | 3 | 3 | 3 | 0 (0%) | 0 (0%) |
| manager | rest:profiles requests: backToHome | 4 | 4 | 4 | 0 (0%) | 0 (0%) |
| manager | rpc:get_required_consents requests: coldStart | 3 | 3 | 3 | 0 (0%) | 0 (0%) |
| manager | rpc:get_required_consents requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | rpc:get_required_consents requests: backToHome | 0 | 0 | 0 | 0 | 0 |
