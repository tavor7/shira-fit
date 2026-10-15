### chromium: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3354 | 1311 | 1211 | -2143 (-64%) | -100 (-8%) |
| athlete | Cold start: home mounts at (ms) | 1554 | 563 | 575 | -979 (-63%) | +12 (+2%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 3 | 2 | -5 (-71%) | -1 (-33%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1317 | 244 | 252 | -1065 (-81%) | +8 (+3%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 1 | 1 | -5 (-83%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2060 | 525 | 560 | -1500 (-73%) | +35 (+7%) |
| athlete | Back: content hidden (ms) | 1752 | 589 | 0 | -1752 (-100%) | -589 (-100%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | Longest request URL: back to home (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 2807 | 1388 | 1104 | -1703 (-61%) | -284 (-20%) |
| coach | Cold start: home mounts at (ms) | 1420 | 700 | 574 | -846 (-60%) | -126 (-18%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 28 | 24 | -11 (-31%) | -4 (-14%) |
| coach | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 36 | 34 | -8 (-19%) | -2 (-6%) |
| coach | Open detail: tap→content (ms) | 518 | 299 | 251 | -267 (-52%) | -48 (-16%) |
| coach | Open detail: requests before content | 10 | 12 | 12 | +2 (+20%) | 0 (0%) |
| coach | Open detail: depth before content | 3 | 2 | 2 | -1 (-33%) | 0 (0%) |
| coach | Open detail: settled (ms) | 1461 | 752 | 649 | -812 (-56%) | -103 (-14%) |
| coach | Back: content hidden (ms) | 1325 | 521 | 0 | -1325 (-100%) | -521 (-100%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| coach | Longest request URL: back to home (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 2815 | 1098 | 1132 | -1683 (-60%) | +34 (+3%) |
| manager | Cold start: home mounts at (ms) | 1385 | 572 | 572 | -813 (-59%) | 0 (0%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 28 | 23 | -13 (-36%) | -5 (-18%) |
| manager | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| manager | Cold start: all requests (network) | 42 | 35 | 33 | -9 (-21%) | -2 (-6%) |
| manager | Open detail: tap→content (ms) | 249 | 250 | 256 | +7 (+3%) | +6 (+2%) |
| manager | Open detail: requests before content | 6 | 9 | 9 | +3 (+50%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 420 | 425 | 427 | +7 (+2%) | +2 (+0%) |
| manager | Roster: focus→content (ms) | 1264 | 645 | 648 | -616 (-49%) | +3 (+0%) |
| manager | Back: content hidden (ms) | 1347 | 471 | 0 | -1347 (-100%) | -471 (-100%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1494 | 602 | 566 | -928 (-62%) | -36 (-6%) |
| manager | Dashboard → Global: click→content (ms) | 1704 | 2137 | 1784 | +80 (+5%) | -353 (-17%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1366 | 496 | 0 | -1366 (-100%) | -496 (-100%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| manager | Longest request URL: back to home (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
