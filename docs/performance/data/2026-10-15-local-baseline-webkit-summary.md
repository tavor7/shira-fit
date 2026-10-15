
### webkit: 15 successful runs

| Role | Metric | Median (p90) |
|---|---|---|
| athlete | Cold start: content since navigation start | 3552 ms (p90 3874 ms) |
| coach | Cold start: content since navigation start | 3103 ms (p90 3307 ms) |
| manager | Cold start: content since navigation start | 3088 ms (p90 3212 ms) |
| athlete | Cold start: startup (shell) requests | 6 |
| coach | Cold start: startup (shell) requests | 6 |
| manager | Cold start: startup (shell) requests | 6 |
| athlete | Cold start: startup sequential depth | 6 |
| coach | Cold start: startup sequential depth | 6 |
| manager | Cold start: startup sequential depth | 6 |
| athlete | Cold start: home requests before content | 34 |
| coach | Cold start: home requests before content | 35 |
| manager | Cold start: home requests before content | 36 |
| athlete | Cold start: home depth before content | 7 (p90 8) |
| coach | Cold start: home depth before content | 6 (p90 7) |
| manager | Cold start: home depth before content | 6 (p90 7) |
| athlete | Cold start: all requests settled (since nav start) | 3537 ms (p90 3862 ms) |
| coach | Cold start: all requests settled (since nav start) | 3346 ms (p90 3545 ms) |
| manager | Cold start: all requests settled (since nav start) | 3313 ms (p90 3477 ms) |
| athlete | Cold start: requests (network, all) | 40 |
| coach | Cold start: requests (network, all) | 42 |
| manager | Cold start: requests (network, all) | 43 |
| athlete | Cold start: response bytes (KB, gzip) | 54 KB |
| coach | Cold start: response bytes (KB, gzip) | 123 KB |
| manager | Cold start: response bytes (KB, gzip) | 123 KB |
| athlete | Open session detail: tap→content | 1470 ms (p90 1530 ms) |
| coach | Open session detail: tap→content | 576 ms (p90 791 ms) |
| manager | Open session detail: tap→content | 281 ms (p90 287 ms) |
| athlete | Open session detail: requests before content | 8 |
| coach | Open session detail: requests before content | 10 |
| manager | Open session detail: requests before content | 6 |
| athlete | Open session detail: depth before content | 6 |
| coach | Open session detail: depth before content | 3 |
| manager | Open session detail: depth before content | 2 |
| athlete | Open session detail: requests in 5 s | 11 |
| coach | Open session detail: requests in 5 s | 19 |
| manager | Open session detail: requests in 5 s | 6 |
| athlete | Open session detail: settled | 2293 ms (p90 3314 ms) |
| coach | Open session detail: settled | 1634 ms (p90 1681 ms) |
| manager | Open session detail: settled | 490 ms (p90 498 ms) |
| athlete | Open session detail: response KB | 17 KB |
| coach | Open session detail: response KB | 37 KB |
| manager | Open session detail: response KB | 37 KB |
| manager | Roster: focus→content | 1431 ms (p90 1511 ms) |
| athlete | Back to home: focus→content | 0 ms |
| coach | Back to home: focus→content | 0 ms |
| manager | Back to home: focus→content | 0 ms |
| athlete | Back to home: content hidden by loading state | 1876 ms (p90 1974 ms) |
| coach | Back to home: content hidden by loading state | 1492 ms (p90 1512 ms) |
| manager | Back to home: content hidden by loading state | 1517 ms (p90 1595 ms) |
| athlete | Back to home: requests in 5 s | 20 |
| coach | Back to home: requests in 5 s | 17 |
| manager | Back to home: requests in 5 s | 18 |
| athlete | Back to home: depth | 7 |
| coach | Back to home: depth | 7 |
| manager | Back to home: depth | 7 |
| athlete | Back to home: response KB | 49 KB |
| coach | Back to home: response KB | 116 KB |
| manager | Back to home: response KB | 116 KB |
| manager | Menu → Overview (dashboard week): tap→content | 379 ms (p90 466 ms) |
| manager | Dashboard week: requests in 5 s | 6 |
| manager | Dashboard → Month: click→content | 511 ms (p90 564 ms) |
| manager | Dashboard → Global: click→content | 1923 ms (p90 2473 ms) |
| manager | Dashboard → Global: response KB | 72 KB |
| manager | Menu → Sessions (home): tap→content | 1546 ms (p90 1635 ms) |
| manager | Menu → Sessions (home): content hidden | 0 ms |
| manager | Menu → Sessions (home): requests in 5 s | 27 |
| manager | Realtime registration: requests in 5 s | 34 |
| manager | Realtime registration: skeleton flashes | 1 |
| manager | Realtime registration: skeleton time | 1368 ms (p90 1399 ms) |
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

Resume (coach): {"rpc:get_required_consents":3,"rpc:get_my_subscription_terms":1,"rpc:get_address_collection_required":2,"rest:profiles":2,"rpc:sync_signup_profile_from_metadata":1,"rpc:get_pending_manager_direct_message":1,"rpc:sync_signup_electronic_receipts_consent":1,"rpc:sync_signup_legal_consents":1}

Resume (manager): {"rpc:get_required_consents":3,"rpc:get_my_subscription_terms":1,"rpc:get_address_collection_required":2,"rest:profiles":2,"rpc:sync_signup_profile_from_metadata":1,"rpc:get_pending_manager_direct_message":1,"rpc:sync_signup_electronic_receipts_consent":1,"rpc:sync_signup_legal_consents":1}
