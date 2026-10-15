### webkit: baseline → candidate (median of 5 vs 5 runs)

| Role | Metric | Baseline | Previous step | Candidate | Δ vs baseline | Δ vs previous |
|---|---|---|---|---|---|---|
| athlete | Cold start: content since navigation start (ms) | 3552 | 2013 | 1420 | -2132 (-60%) | -593 (-29%) |
| athlete | Cold start: home mounts at (ms) | 1603 | 679 | 735 | -868 (-54%) | +56 (+8%) |
| athlete | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| athlete | Cold start: home requests before content | 34 | 27 | 27 | -7 (-21%) | 0 (0%) |
| athlete | Cold start: home depth before content | 7 | 5 | 2 | -5 (-71%) | -3 (-60%) |
| athlete | Cold start: all requests (network) | 40 | 29 | 29 | -11 (-28%) | 0 (0%) |
| athlete | Open detail: tap→content (ms) | 1470 | 1179 | 1178 | -292 (-20%) | -1 (0%) |
| athlete | Open detail: requests before content | 8 | 7 | 7 | -1 (-12%) | 0 (0%) |
| athlete | Open detail: depth before content | 6 | 5 | 5 | -1 (-17%) | 0 (0%) |
| athlete | Open detail: settled (ms) | 2293 | 1730 | 1518 | -775 (-34%) | -212 (-12%) |
| athlete | Back: content hidden (ms) | 1876 | 1341 | 569 | -1307 (-70%) | -772 (-58%) |
| athlete | Back: requests in 5 s | 20 | 15 | 15 | -5 (-25%) | 0 (0%) |
| athlete | Back: depth | 7 | 5 | 2 | -5 (-71%) | -3 (-60%) |
| athlete | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| athlete | Longest request URL: cold start (chars) | – | – | 339 | – | – |
| athlete | Longest request URL: back to home (chars) | – | – | 339 | – | – |
| athlete | auth:user requests: coldStart | 9 | 4 | 4 | -5 (-56%) | 0 (0%) |
| athlete | auth:user requests: openDetail | 2 | 0 | 0 | -2 (-100%) | 0 |
| athlete | auth:user requests: backToHome | 7 | 2 | 2 | -5 (-71%) | 0 (0%) |
| coach | Cold start: content since navigation start (ms) | 3103 | 2160 | 1271 | -1832 (-59%) | -889 (-41%) |
| coach | Cold start: home mounts at (ms) | 1603 | 658 | 676 | -927 (-58%) | +18 (+3%) |
| coach | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| coach | Cold start: home requests before content | 35 | 34 | 28 | -7 (-20%) | -6 (-18%) |
| coach | Cold start: home depth before content | 6 | 6 | 3 | -3 (-50%) | -3 (-50%) |
| coach | Cold start: all requests (network) | 42 | 37 | 36 | -6 (-14%) | -1 (-3%) |
| coach | Open detail: tap→content (ms) | 576 | 292 | 294 | -282 (-49%) | +2 (+1%) |
| coach | Open detail: requests before content | 10 | 7 | 8 | -2 (-20%) | +1 (+14%) |
| coach | Open detail: depth before content | 3 | 1 | 2 | -1 (-33%) | +1 (+100%) |
| coach | Open detail: settled (ms) | 1634 | 1661 | 1649 | +15 (+1%) | -12 (-1%) |
| coach | Back: content hidden (ms) | 1492 | 1547 | 581 | -911 (-61%) | -966 (-62%) |
| coach | Back: requests in 5 s | 17 | 17 | 17 | 0 (0%) | 0 (0%) |
| coach | Back: depth | 7 | 7 | 5 | -2 (-29%) | -2 (-29%) |
| coach | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| coach | Longest request URL: cold start (chars) | – | – | 4955 | – | – |
| coach | Longest request URL: back to home (chars) | – | – | 4955 | – | – |
| coach | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| coach | auth:user requests: openDetail | 1 | 0 | 0 | -1 (-100%) | 0 |
| coach | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
| manager | Cold start: content since navigation start (ms) | 3088 | 2183 | 1506 | -1582 (-51%) | -677 (-31%) |
| manager | Cold start: home mounts at (ms) | 1568 | 682 | 691 | -877 (-56%) | +9 (+1%) |
| manager | Cold start: shell requests | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: shell depth | 6 | 2 | 2 | -4 (-67%) | 0 (0%) |
| manager | Cold start: home requests before content | 36 | 34 | 29 | -7 (-19%) | -5 (-15%) |
| manager | Cold start: home depth before content | 6 | 6 | 3 | -3 (-50%) | -3 (-50%) |
| manager | Cold start: all requests (network) | 43 | 37 | 37 | -6 (-14%) | 0 (0%) |
| manager | Open detail: tap→content (ms) | 281 | 280 | 283 | +2 (+1%) | +3 (+1%) |
| manager | Open detail: requests before content | 6 | 6 | 6 | 0 (0%) | 0 (0%) |
| manager | Open detail: depth before content | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | Open detail: settled (ms) | 490 | 489 | 504 | +14 (+3%) | +15 (+3%) |
| manager | Roster: focus→content (ms) | 1431 | 1466 | 1439 | +8 (+1%) | -27 (-2%) |
| manager | Back: content hidden (ms) | 1517 | 1553 | 575 | -942 (-62%) | -978 (-63%) |
| manager | Back: requests in 5 s | 18 | 18 | 18 | 0 (0%) | 0 (0%) |
| manager | Back: depth | 7 | 7 | 5 | -2 (-29%) | -2 (-29%) |
| manager | Menu → Sessions: tap→content (ms) | 1546 | 1570 | 717 | -829 (-54%) | -853 (-54%) |
| manager | Dashboard → Global: click→content (ms) | 1923 | 1795 | 1976 | +53 (+3%) | +181 (+10%) |
| manager | Realtime: requests in 5 s | 34 | 34 | 34 | 0 (0%) | 0 (0%) |
| manager | Realtime: skeleton (ms) | 1368 | 1391 | 562 | -806 (-59%) | -829 (-60%) |
| manager | Resume: requests in 5 s | 12 | 8 | 8 | -4 (-33%) | 0 (0%) |
| manager | Longest request URL: cold start (chars) | – | – | 4955 | – | – |
| manager | Longest request URL: back to home (chars) | – | – | 4955 | – | – |
| manager | auth:user requests: coldStart | 2 | 2 | 2 | 0 (0%) | 0 (0%) |
| manager | auth:user requests: openDetail | 0 | 0 | 0 | 0 | 0 |
| manager | auth:user requests: backToHome | 0 | 0 | 0 | 0 | 0 |
