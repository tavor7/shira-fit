### chromium: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3354 | 1751 | 1223 | -2131 (-64%) | -528 (-30%) |
| athlete | Cold start: home mounts at (ms) | 1554 | 572 | 615 | -939 (-60%) | +43 (+8%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 5 | 2 | -5 (-71%) | -3 (-60%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1317 | 1066 | 1051 | -266 (-20%) | -15 (-1%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 5 | -1 (-17%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2060 | 1540 | 1347 | -713 (-35%) | -193 (-13%) |
| athlete | Back: content hidden (ms) | 1752 | 1175 | 573 | -1179 (-67%) | -602 (-51%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 5 | 2 | -5 (-71%) | -3 (-60%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | – | 339 | – | – |
| athlete | Longest request URL: back to home (chars) | – | – | 339 | – | – |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 2807 | 1983 | 1161 | -1646 (-59%) | -822 (-41%) |
| coach | Cold start: home mounts at (ms) | 1420 | 589 | 589 | -831 (-59%) | 0 (0%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 34 | 28 | -7 (-20%) | -6 (-18%) |
| coach | Cold start: home depth before content | 6 | 6 | 3 | -3 (-50%) | -3 (-50%) |
| coach | Cold start: all requests (network) | 42 | 37 | 36 | -6 (-14%) | -1 (-3%) |
| coach | Open detail: tap→content (ms) | 518 | 258 | 259 | -259 (-50%) | +1 (+0%) |
| coach | Open detail: requests before content | 10 | 8 | 8 | -2 (-20%) | 0 (0%) |
| coach | Open detail: depth before content | 3 | 2 | 2 | -1 (-33%) | 0 (0%) |
| coach | Open detail: settled (ms) | 1461 | 1498 | 1497 | +36 (+2%) | -1 (0%) |
| coach | Back: content hidden (ms) | 1325 | 1348 | 500 | -825 (-62%) | -848 (-63%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 7 | 5 | -2 (-29%) | -2 (-29%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | – | 4955 | – | – |
| coach | Longest request URL: back to home (chars) | – | – | 4955 | – | – |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 2815 | 1927 | 1166 | -1649 (-59%) | -761 (-39%) |
| manager | Cold start: home mounts at (ms) | 1385 | 562 | 637 | -748 (-54%) | +75 (+13%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 34 | 29 | -7 (-19%) | -5 (-15%) |
| manager | Cold start: home depth before content | 6 | 6 | 3 | -3 (-50%) | -3 (-50%) |
| manager | Cold start: all requests (network) | 42 | 36 | 36 | -6 (-14%) | 0 (0%) |
| manager | Open detail: tap→content (ms) | 249 | 247 | 246 | -3 (-1%) | -1 (0%) |
| manager | Open detail: requests before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 420 | 417 | 414 | -6 (-1%) | -3 (-1%) |
| manager | Roster: focus→content (ms) | 1264 | 1268 | 1259 | -5 (0%) | -9 (-1%) |
| manager | Back: content hidden (ms) | 1347 | 1352 | 530 | -817 (-61%) | -822 (-61%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 7 | 5 | -2 (-29%) | -2 (-29%) |
| manager | Menu → Sessions: tap→content (ms) | 1494 | 1372 | 569 | -925 (-62%) | -803 (-59%) |
| manager | Dashboard → Global: click→content (ms) | 1704 | 1747 | 1801 | +97 (+6%) | +54 (+3%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1366 | 1352 | 488 | -878 (-64%) | -864 (-64%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | – | 4955 | – | – |
| manager | Longest request URL: back to home (chars) | – | – | 4955 | – | – |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
