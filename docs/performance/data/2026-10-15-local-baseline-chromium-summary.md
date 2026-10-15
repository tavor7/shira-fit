
### chromium: 15 successful runs

| Role | Metric | Median (p90) |
|---|---|---|
| athlete | Cold start: content since navigation start | 3354 ms (p90 4153 ms) |
| coach | Cold start: content since navigation start | 2807 ms (p90 2847 ms) |
| manager | Cold start: content since navigation start | 2815 ms (p90 2894 ms) |
| athlete | Cold start: startup (shell) requests | 6 |
| coach | Cold start: startup (shell) requests | 6 |
| manager | Cold start: startup (shell) requests | 6 |
| athlete | Cold start: startup sequential depth | 6 |
| coach | Cold start: startup sequential depth | 6 |
| manager | Cold start: startup sequential depth | 6 |
| athlete | Cold start: home requests before content | 34 |
| coach | Cold start: home requests before content | 35 |
| manager | Cold start: home requests before content | 36 |
| athlete | Cold start: home depth before content | 7 (p90 9) |
| coach | Cold start: home depth before content | 6 |
| manager | Cold start: home depth before content | 6 |
| athlete | Cold start: all requests settled (since nav start) | 3344 ms (p90 4140 ms) |
| coach | Cold start: all requests settled (since nav start) | 3038 ms (p90 3078 ms) |
| manager | Cold start: all requests settled (since nav start) | 3045 ms (p90 3130 ms) |
| athlete | Cold start: requests (network, all) | 40 |
| coach | Cold start: requests (network, all) | 42 |
| manager | Cold start: requests (network, all) | 42 |
| athlete | Cold start: response bytes (KB, gzip) | 54 KB |
| coach | Cold start: response bytes (KB, gzip) | 123 KB |
| manager | Cold start: response bytes (KB, gzip) | 123 KB |
| athlete | Open session detail: tap→content | 1317 ms (p90 1540 ms) |
| coach | Open session detail: tap→content | 518 ms (p90 777 ms) |
| manager | Open session detail: tap→content | 249 ms (p90 264 ms) |
| athlete | Open session detail: requests before content | 8 |
| coach | Open session detail: requests before content | 10 |
| manager | Open session detail: requests before content | 6 |
| athlete | Open session detail: depth before content | 6 |
| coach | Open session detail: depth before content | 3 |
| manager | Open session detail: depth before content | 2 |
| athlete | Open session detail: requests in 5 s | 11 |
| coach | Open session detail: requests in 5 s | 19 |
| manager | Open session detail: requests in 5 s | 6 |
| athlete | Open session detail: settled | 2060 ms (p90 2330 ms) |
| coach | Open session detail: settled | 1461 ms (p90 1611 ms) |
| manager | Open session detail: settled | 420 ms (p90 432 ms) |
| athlete | Open session detail: response KB | 17 KB |
| coach | Open session detail: response KB | 37 KB |
| manager | Open session detail: response KB | 37 KB |
| manager | Roster: focus→content | 1264 ms (p90 1280 ms) |
| athlete | Back to home: focus→content | 0 ms |
| coach | Back to home: focus→content | 0 ms |
| manager | Back to home: focus→content | 0 ms |
| athlete | Back to home: content hidden by loading state | 1752 ms (p90 1921 ms) |
| coach | Back to home: content hidden by loading state | 1325 ms (p90 1495 ms) |
| manager | Back to home: content hidden by loading state | 1347 ms (p90 1467 ms) |
| athlete | Back to home: requests in 5 s | 20 |
| coach | Back to home: requests in 5 s | 17 |
| manager | Back to home: requests in 5 s | 18 |
| athlete | Back to home: depth | 7 |
| coach | Back to home: depth | 7 |
| manager | Back to home: depth | 7 |
| athlete | Back to home: response KB | 49 KB |
| coach | Back to home: response KB | 116 KB |
| manager | Back to home: response KB | 116 KB |
| manager | Menu → Overview (dashboard week): tap→content | 378 ms (p90 454 ms) |
| manager | Dashboard week: requests in 5 s | 6 |
| manager | Dashboard → Month: click→content | 450 ms (p90 649 ms) |
| manager | Dashboard → Global: click→content | 1704 ms (p90 2216 ms) |
| manager | Dashboard → Global: response KB | 72 KB |
| manager | Menu → Sessions (home): tap→content | 1494 ms (p90 1752 ms) |
| manager | Menu → Sessions (home): content hidden | 0 ms |
| manager | Menu → Sessions (home): requests in 5 s | 27 |
| manager | Realtime registration: requests in 5 s | 34 |
| manager | Realtime registration: skeleton flashes | 1 |
| manager | Realtime registration: skeleton time | 1366 ms (p90 1392 ms) |
| athlete | Resume after 35 s hidden: requests in 5 s | 12 |
| coach | Resume after 35 s hidden: requests in 5 s | 12 |
| manager | Resume after 35 s hidden: requests in 5 s | 12 |

Startup (shell) requests per cold start, by endpoint (average over runs):

| Role | Endpoint | Per cold start |
|---|---|---|
| athlete | rest:profiles | 3.0 |
| athlete | rpc:sync_signup_electronic_receipts_consent | 1.0 |
| athlete | rpc:sync_signup_legal_consents | 1.0 |
| athlete | rpc:sync_signup_profile_from_metadata | 1.0 |
| coach | rest:profiles | 3.0 |
| coach | rpc:sync_signup_electronic_receipts_consent | 1.0 |
| coach | rpc:sync_signup_legal_consents | 1.0 |
| coach | rpc:sync_signup_profile_from_metadata | 1.0 |
| manager | rest:profiles | 3.0 |
| manager | rpc:sync_signup_electronic_receipts_consent | 1.0 |
| manager | rpc:sync_signup_legal_consents | 1.0 |
| manager | rpc:sync_signup_profile_from_metadata | 1.0 |

Resume (athlete): {"rpc:get_required_consents":3,"rpc:get_my_subscription_terms":1,"rpc:get_address_collection_required":2,"rest:profiles":2,"rpc:sync_signup_profile_from_metadata":1,"rpc:get_pending_manager_direct_message":1,"rpc:sync_signup_electronic_receipts_consent":1,"rpc:sync_signup_legal_consents":1}

Resume (coach): {"rpc:get_required_consents":3,"rpc:get_my_subscription_terms":1,"rpc:get_address_collection_required":2,"rest:profiles":2,"rpc:get_pending_manager_direct_message":1,"rpc:sync_signup_profile_from_metadata":1,"rpc:sync_signup_electronic_receipts_consent":1,"rpc:sync_signup_legal_consents":1}

Resume (manager): {"rpc:get_required_consents":3,"rpc:get_my_subscription_terms":1,"rpc:get_address_collection_required":2,"rest:profiles":2,"rpc:get_pending_manager_direct_message":1,"rpc:sync_signup_profile_from_metadata":1,"rpc:sync_signup_electronic_receipts_consent":1,"rpc:sync_signup_legal_consents":1}
