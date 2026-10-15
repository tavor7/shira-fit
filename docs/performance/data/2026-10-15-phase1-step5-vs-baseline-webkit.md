### webkit: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3552 | 2456 | 1409 | -2143 (-60%) | -1047 (-43%) |
| athlete | Cold start: home mounts at (ms) | 1603 | 841 | 705 | -898 (-56%) | -136 (-16%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 3 | 2 | -5 (-71%) | -1 (-33%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1470 | 365 | 274 | -1196 (-81%) | -91 (-25%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 1 | 1 | -5 (-83%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2293 | 906 | 591 | -1702 (-74%) | -315 (-35%) |
| athlete | Back: content hidden (ms) | 1876 | 858 | 0 | -1876 (-100%) | -858 (-100%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | Longest request URL: back to home (chars) | – | 339 | 339 | – | 0 (0%) |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 3103 | 1409 | 1233 | -1870 (-60%) | -176 (-12%) |
| coach | Cold start: home mounts at (ms) | 1603 | 774 | 671 | -932 (-58%) | -103 (-13%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 28 | 24 | -11 (-31%) | -4 (-14%) |
| coach | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| coach | Cold start: all requests (network) | 42 | 36 | 34 | -8 (-19%) | -2 (-6%) |
| coach | Open detail: tap→content (ms) | 576 | 324 | 304 | -272 (-47%) | -20 (-6%) |
| coach | Open detail: requests before content | 10 | 12 | 12 | +2 (+20%) | 0 (0%) |
| coach | Open detail: depth before content | 3 | 2 | 2 | -1 (-33%) | 0 (0%) |
| coach | Open detail: settled (ms) | 1634 | 754 | 730 | -904 (-55%) | -24 (-3%) |
| coach | Back: content hidden (ms) | 1492 | 539 | 0 | -1492 (-100%) | -539 (-100%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| coach | Longest request URL: back to home (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 3088 | 1472 | 1200 | -1888 (-61%) | -272 (-18%) |
| manager | Cold start: home mounts at (ms) | 1568 | 758 | 654 | -914 (-58%) | -104 (-14%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 28 | 23 | -13 (-36%) | -5 (-18%) |
| manager | Cold start: home depth before content | 6 | 3 | 3 | -3 (-50%) | 0 (0%) |
| manager | Cold start: all requests (network) | 43 | 36 | 34 | -9 (-21%) | -2 (-6%) |
| manager | Open detail: tap→content (ms) | 281 | 288 | 292 | +11 (+4%) | +4 (+1%) |
| manager | Open detail: requests before content | 6 | 9 | 9 | +3 (+50%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 490 | 498 | 495 | +5 (+1%) | -3 (-1%) |
| manager | Roster: focus→content (ms) | 1431 | 791 | 746 | -685 (-48%) | -45 (-6%) |
| manager | Back: content hidden (ms) | 1517 | 504 | 0 | -1517 (-100%) | -504 (-100%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 5 | 5 | -2 (-29%) | 0 (0%) |
| manager | Menu → Sessions: tap→content (ms) | 1546 | 729 | 594 | -952 (-62%) | -135 (-19%) |
| manager | Dashboard → Global: click→content (ms) | 1923 | 1987 | 1817 | -106 (-6%) | -170 (-9%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1368 | 608 | 0 | -1368 (-100%) | -608 (-100%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| manager | Longest request URL: back to home (chars) | – | 4916 | 4877 | – | -39 (-1%) |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
