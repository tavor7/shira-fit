### webkit: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3552 | 2880 | 2013 | -1539 (-43%) | -867 (-30%) |
| athlete | Cold start: home mounts at (ms) | 1603 | 1586 | 679 | -924 (-58%) | -907 (-57%) |
| athlete | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| athlete | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| athlete | Cold start: home requests before content | 34 | 29 | 27 | -7 (-21%) | -2 (-7%) |
| athlete | Cold start: home depth before content | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| athlete | Cold start: all requests (network) | 40 | 35 | 29 | -11 (-28%) | -6 (-17%) |
| athlete | Open detail: tap→content (ms) | 1470 | 1182 | 1179 | -291 (-20%) | -3 (0%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 5 | -1 (-17%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2293 | 1728 | 1730 | -563 (-25%) | +2 (+0%) |
| athlete | Back: content hidden (ms) | 1876 | 1286 | 1341 | -535 (-29%) | +55 (+4%) |
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
| coach | Cold start: content since navigation start (ms) | 3103 | 3053 | 2160 | -943 (-30%) | -893 (-29%) |
| coach | Cold start: home mounts at (ms) | 1603 | 1589 | 658 | -945 (-59%) | -931 (-59%) |
| coach | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| coach | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| coach | Cold start: home requests before content | 35 | 35 | 34 | -1 (-3%) | -1 (-3%) |
| coach | Cold start: home depth before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 42 | 37 | -5 (-12%) | -5 (-12%) |
| coach | Open detail: tap→content (ms) | 576 | 284 | 292 | -284 (-49%) | +8 (+3%) |
| coach | Open detail: requests before content | 10 | 8 | 7 | -3 (-30%) | -1 (-12%) |
| coach | Open detail: depth before content | 3 | 2 | 1 | -2 (-67%) | -1 (-50%) |
| coach | Open detail: settled (ms) | 1634 | 1652 | 1661 | +27 (+2%) | +9 (+1%) |
| coach | Back: content hidden (ms) | 1492 | 1523 | 1547 | +55 (+4%) | +24 (+2%) |
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
| manager | Cold start: content since navigation start (ms) | 3088 | 3095 | 2183 | -905 (-29%) | -912 (-29%) |
| manager | Cold start: home mounts at (ms) | 1568 | 1602 | 682 | -886 (-57%) | -920 (-57%) |
| manager | Cold start: shell requests | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| manager | Cold start: shell depth | 6 | 6 | 2 | -4 (-67%) | -4 (-67%) |
| manager | Cold start: home requests before content | 36 | 36 | 34 | -2 (-6%) | -2 (-6%) |
| manager | Cold start: home depth before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Cold start: all requests (network) | 43 | 43 | 37 | -6 (-14%) | -6 (-14%) |
| manager | Open detail: tap→content (ms) | 281 | 285 | 280 | -1 (0%) | -5 (-2%) |
| manager | Open detail: requests before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 490 | 498 | 489 | -1 (0%) | -9 (-2%) |
| manager | Roster: focus→content (ms) | 1431 | 1429 | 1466 | +35 (+2%) | +37 (+3%) |
| manager | Back: content hidden (ms) | 1517 | 1502 | 1553 | +36 (+2%) | +51 (+3%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 7 | 7 | 0 (0%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1546 | 1549 | 1570 | +24 (+2%) | +21 (+1%) |
| manager | Dashboard → Global: click→content (ms) | 1923 | 1795 | 1795 | -128 (-7%) | 0 (0%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1368 | 1381 | 1391 | +23 (+2%) | +10 (+1%) |
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
