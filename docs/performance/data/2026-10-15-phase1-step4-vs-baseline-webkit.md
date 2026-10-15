### webkit: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3552 | 1420 | 2456 | -1096 (-31%) | +1036 (+73%) |
| athlete | Cold start: home mounts at (ms) | 1603 | 735 | 841 | -762 (-48%) | +106 (+14%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 2 | 3 | -4 (-57%) | +1 (+50%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1470 | 1178 | 365 | -1105 (-75%) | -813 (-69%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 1 | -5 (-83%) | -4 (-80%) |
| athlete | Open detail: settled (ms) | 2293 | 1518 | 906 | -1387 (-60%) | -612 (-40%) |
| athlete | Back: content hidden (ms) | 1876 | 569 | 858 | -1018 (-54%) | +289 (+51%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | Longest request URL: back to home (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 3103 | 1271 | 1409 | -1694 (-55%) | +138 (+11%) |
| coach | Cold start: home mounts at (ms) | 1603 | 676 | 774 | -829 (-52%) | +98 (+14%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 28 | 28 | -7 (-20%) | 0 (0%) |
| coach | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 36 | 36 | -6 (-14%) | 0 (0%) |
| coach | Open detail: tap→content (ms) | 576 | 294 | 324 | -252 (-44%) | +30 (+10%) |
| coach | Open detail: requests before content | 10 | 8 | 12 | +2 (+20%) | +4 (+50%) |
| coach | Open detail: depth before content | 3 | 2 | 2 | -1 (-33%) | 0 (0%) |
| coach | Open detail: settled (ms) | 1634 | 1649 | 754 | -880 (-54%) | -895 (-54%) |
| coach | Back: content hidden (ms) | 1492 | 581 | 539 | -953 (-64%) | -42 (-7%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| coach | Longest request URL: back to home (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 3088 | 1506 | 1472 | -1616 (-52%) | -34 (-2%) |
| manager | Cold start: home mounts at (ms) | 1568 | 691 | 758 | -810 (-52%) | +67 (+10%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 29 | 28 | -8 (-22%) | -1 (-3%) |
| manager | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| manager | Cold start: all requests (network) | 43 | 37 | 36 | -7 (-16%) | -1 (-3%) |
| manager | Open detail: tap→content (ms) | 281 | 283 | 288 | +7 (+2%) | +5 (+2%) |
| manager | Open detail: requests before content | 6 | 6 | 9 | +3 (+50%) | +3 (+50%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 490 | 504 | 498 | +8 (+2%) | -6 (-1%) |
| manager | Roster: focus→content (ms) | 1431 | 1439 | 791 | -640 (-45%) | -648 (-45%) |
| manager | Back: content hidden (ms) | 1517 | 575 | 504 | -1013 (-67%) | -71 (-12%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1546 | 717 | 729 | -817 (-53%) | +12 (+2%) |
| manager | Dashboard → Global: click→content (ms) | 1923 | 1976 | 1987 | +64 (+3%) | +11 (+1%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1368 | 562 | 608 | -760 (-56%) | +46 (+8%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| manager | Longest request URL: back to home (chars) | – | 4955 | 4916 | – | -39 (-1%) |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
