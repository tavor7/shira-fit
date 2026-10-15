### chromium: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3354 | 1223 | 1311 | -2043 (-61%) | +88 (+7%) |
| athlete | Cold start: home mounts at (ms) | 1554 | 615 | 563 | -991 (-64%) | -52 (-8%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 2 | 3 | -4 (-57%) | +1 (+50%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1317 | 1051 | 244 | -1073 (-81%) | -807 (-77%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 1 | -5 (-83%) | -4 (-80%) |
| athlete | Open detail: settled (ms) | 2060 | 1347 | 525 | -1535 (-75%) | -822 (-61%) |
| athlete | Back: content hidden (ms) | 1752 | 573 | 589 | -1163 (-66%) | +16 (+3%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | Longest request URL: back to home (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 2807 | 1161 | 1388 | -1419 (-51%) | +227 (+20%) |
| coach | Cold start: home mounts at (ms) | 1420 | 589 | 700 | -720 (-51%) | +111 (+19%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 28 | 28 | -7 (-20%) | 0 (0%) |
| coach | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 36 | 36 | -6 (-14%) | 0 (0%) |
| coach | Open detail: tap→content (ms) | 518 | 259 | 299 | -219 (-42%) | +40 (+15%) |
| coach | Open detail: requests before content | 10 | 8 | 12 | +2 (+20%) | +4 (+50%) |
| coach | Open detail: depth before content | 3 | 2 | 2 | -1 (-33%) | 0 (0%) |
| coach | Open detail: settled (ms) | 1461 | 1497 | 752 | -709 (-49%) | -745 (-50%) |
| coach | Back: content hidden (ms) | 1325 | 500 | 521 | -804 (-61%) | +21 (+4%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| coach | Longest request URL: back to home (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 2815 | 1166 | 1098 | -1717 (-61%) | -68 (-6%) |
| manager | Cold start: home mounts at (ms) | 1385 | 637 | 572 | -813 (-59%) | -65 (-10%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 29 | 28 | -8 (-22%) | -1 (-3%) |
| manager | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| manager | Cold start: all requests (network) | 42 | 36 | 35 | -7 (-17%) | -1 (-3%) |
| manager | Open detail: tap→content (ms) | 249 | 246 | 250 | +1 (+0%) | +4 (+2%) |
| manager | Open detail: requests before content | 6 | 6 | 9 | +3 (+50%) | +3 (+50%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 420 | 414 | 425 | +5 (+1%) | +11 (+3%) |
| manager | Roster: focus→content (ms) | 1264 | 1259 | 645 | -619 (-49%) | -614 (-49%) |
| manager | Back: content hidden (ms) | 1347 | 530 | 471 | -876 (-65%) | -59 (-11%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1494 | 569 | 602 | -892 (-60%) | +33 (+6%) |
| manager | Dashboard → Global: click→content (ms) | 1704 | 1801 | 2137 | +433 (+25%) | +336 (+19%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1366 | 488 | 496 | -870 (-64%) | +8 (+2%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| manager | Longest request URL: back to home (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
