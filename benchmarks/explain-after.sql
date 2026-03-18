=== EXPLAIN ANALYZE — After Optimization ===
Date: Tue Mar 17 19:32:49 CDT 2026
Commit: 5658776

=== Query 1: Dashboard /my-work (projects with inferred_status) ===
                                                                                  QUERY PLAN                                                                                   
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=30.81..30.93 rows=50 width=926) (actual time=0.224..0.234 rows=50 loops=1)
   Buffers: shared hit=26
   ->  Sort  (cost=30.81..31.11 rows=119 width=926) (actual time=0.223..0.227 rows=50 loops=1)
         Sort Key: updated_at DESC
         Sort Method: top-N heapsort  Memory: 83kB
         Buffers: shared hit=26
         ->  Seq Scan on documents d  (cost=0.00..26.86 rows=119 width=926) (actual time=0.017..0.149 rows=119 loops=1)
               Filter: ((deleted_at IS NULL) AND (document_type = ANY ('{project,issue}'::document_type[])) AND (workspace_id = '2bc2b1df-041f-4313-9c95-b184b5477a0a'::uuid))
               Rows Removed by Filter: 138
               Buffers: shared hit=23
 Planning:
   Buffers: shared hit=490
 Planning Time: 6.043 ms
 Execution Time: 0.276 ms
(14 rows)


=== Query 2: Weeks list (sprints with counts) — BEFORE had 70 seq scans ===
                                                                               QUERY PLAN                                                                               
------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=917.05..917.13 rows=35 width=946) (actual time=0.709..0.713 rows=35 loops=1)
   Sort Key: (((d.properties ->> 'sprint_number'::text))::integer) DESC
   Sort Method: quicksort  Memory: 46kB
   Buffers: shared hit=318
   ->  Nested Loop Left Join  (cost=25.38..916.15 rows=35 width=946) (actual time=0.096..0.653 rows=35 loops=1)
         Buffers: shared hit=315
         ->  Seq Scan on documents d  (cost=0.00..26.86 rows=35 width=926) (actual time=0.020..0.098 rows=35 loops=1)
               Filter: ((deleted_at IS NULL) AND (workspace_id = '2bc2b1df-041f-4313-9c95-b184b5477a0a'::uuid) AND (document_type = 'sprint'::document_type))
               Rows Removed by Filter: 222
               Buffers: shared hit=23
         ->  Aggregate  (cost=25.38..25.39 rows=1 width=16) (actual time=0.015..0.015 rows=1 loops=35)
               Buffers: shared hit=292
               ->  Nested Loop  (cost=4.33..25.37 rows=1 width=212) (actual time=0.007..0.013 rows=2 loops=35)
                     Buffers: shared hit=292
                     ->  Bitmap Heap Scan on document_associations ida  (cost=4.17..8.99 rows=2 width=16) (actual time=0.003..0.004 rows=3 loops=35)
                           Recheck Cond: ((related_id = d.id) AND (relationship_type = 'sprint'::relationship_type))
                           Heap Blocks: exact=41
                           Buffers: shared hit=76
                           ->  Bitmap Index Scan on idx_document_associations_related_type  (cost=0.00..4.17 rows=2 width=0) (actual time=0.002..0.002 rows=3 loops=35)
                                 Index Cond: ((related_id = d.id) AND (relationship_type = 'sprint'::relationship_type))
                                 Buffers: shared hit=35
                     ->  Memoize  (cost=0.16..8.18 rows=1 width=228) (actual time=0.002..0.002 rows=1 loops=108)
                           Cache Key: ida.document_id
                           Cache Mode: logical
                           Hits: 0  Misses: 108  Evictions: 0  Overflows: 0  Memory Usage: 30kB
                           Buffers: shared hit=216
                           ->  Index Scan using documents_pkey on documents i  (cost=0.15..8.17 rows=1 width=228) (actual time=0.001..0.001 rows=1 loops=108)
                                 Index Cond: (id = ida.document_id)
                                 Filter: (document_type = 'issue'::document_type)
                                 Rows Removed by Filter: 0
                                 Buffers: shared hit=216
 Planning:
   Buffers: shared hit=732
 Planning Time: 4.481 ms
 Execution Time: 0.833 ms
(35 rows)


=== Query 3: Issues list ===
                                                                         QUERY PLAN                                                                          
-------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=30.34..30.59 rows=100 width=926) (actual time=0.177..0.193 rows=100 loops=1)
   Buffers: shared hit=26
   ->  Sort  (cost=30.34..30.60 rows=104 width=926) (actual time=0.176..0.182 rows=100 loops=1)
         Sort Key: updated_at DESC
         Sort Method: quicksort  Memory: 77kB
         Buffers: shared hit=26
         ->  Seq Scan on documents d  (cost=0.00..26.86 rows=104 width=926) (actual time=0.013..0.121 rows=104 loops=1)
               Filter: ((deleted_at IS NULL) AND (workspace_id = '2bc2b1df-041f-4313-9c95-b184b5477a0a'::uuid) AND (document_type = 'issue'::document_type))
               Rows Removed by Filter: 153
               Buffers: shared hit=23
 Planning:
   Buffers: shared hit=468
 Planning Time: 2.294 ms
 Execution Time: 0.236 ms
(14 rows)


=== Query 4: Sprint detail (single week) — BEFORE had 2 correlated subqueries ===
                                                                           QUERY PLAN                                                                            
-----------------------------------------------------------------------------------------------------------------------------------------------------------------
 Nested Loop Left Join  (cost=25.53..33.57 rows=1 width=942) (actual time=0.034..0.035 rows=1 loops=1)
   Buffers: shared hit=15
   ->  Index Scan using documents_pkey on documents d  (cost=0.15..8.17 rows=1 width=926) (actual time=0.004..0.004 rows=1 loops=1)
         Index Cond: (id = '1d3cacfd-4927-4eb2-8f02-6628c7714907'::uuid)
         Buffers: shared hit=2
   ->  Aggregate  (cost=25.38..25.39 rows=1 width=16) (actual time=0.029..0.029 rows=1 loops=1)
         Buffers: shared hit=13
         ->  Nested Loop  (cost=4.33..25.37 rows=1 width=212) (actual time=0.017..0.023 rows=4 loops=1)
               Buffers: shared hit=13
               ->  Bitmap Heap Scan on document_associations ida  (cost=4.17..8.99 rows=2 width=16) (actual time=0.009..0.010 rows=5 loops=1)
                     Recheck Cond: ((related_id = d.id) AND (relationship_type = 'sprint'::relationship_type))
                     Heap Blocks: exact=2
                     Buffers: shared hit=3
                     ->  Bitmap Index Scan on idx_document_associations_related_type  (cost=0.00..4.17 rows=2 width=0) (actual time=0.005..0.005 rows=5 loops=1)
                           Index Cond: ((related_id = d.id) AND (relationship_type = 'sprint'::relationship_type))
                           Buffers: shared hit=1
               ->  Memoize  (cost=0.16..8.18 rows=1 width=228) (actual time=0.002..0.002 rows=1 loops=5)
                     Cache Key: ida.document_id
                     Cache Mode: logical
                     Hits: 0  Misses: 5  Evictions: 0  Overflows: 0  Memory Usage: 2kB
                     Buffers: shared hit=10
                     ->  Index Scan using documents_pkey on documents i  (cost=0.15..8.17 rows=1 width=228) (actual time=0.002..0.002 rows=1 loops=5)
                           Index Cond: (id = ida.document_id)
                           Filter: (document_type = 'issue'::document_type)
                           Rows Removed by Filter: 0
                           Buffers: shared hit=10
 Planning:
   Buffers: shared hit=689
 Planning Time: 1.405 ms
 Execution Time: 0.068 ms
(30 rows)


=== Query 5: Auth middleware (combined query — was 3 separate queries) ===
                                                         QUERY PLAN                                                          
-----------------------------------------------------------------------------------------------------------------------------
 Hash Join  (cost=2.02..3.36 rows=1 width=113) (actual time=0.040..0.042 rows=0 loops=1)
   Hash Cond: (u.id = s.user_id)
   Buffers: shared hit=1
   ->  Seq Scan on users u  (cost=0.00..1.24 rows=24 width=17) (actual time=0.019..0.019 rows=1 loops=1)
         Buffers: shared hit=1
   ->  Hash  (cost=2.01..2.01 rows=1 width=112) (actual time=0.012..0.013 rows=0 loops=1)
         Buckets: 1024  Batches: 1  Memory Usage: 8kB
         ->  Hash Right Join  (cost=0.01..2.01 rows=1 width=112) (actual time=0.012..0.013 rows=0 loops=1)
               Hash Cond: ((wm.workspace_id = s.workspace_id) AND (wm.user_id = s.user_id))
               ->  Seq Scan on workspace_memberships wm  (cost=0.00..1.65 rows=65 width=64) (never executed)
               ->  Hash  (cost=0.00..0.00 rows=1 width=80) (actual time=0.003..0.004 rows=0 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 8kB
                     ->  Seq Scan on sessions s  (cost=0.00..0.00 rows=1 width=80) (actual time=0.003..0.003 rows=0 loops=1)
                           Filter: (id = 'test-session-id-that-does-not-exist'::text)
 Planning:
   Buffers: shared hit=425 read=4
 Planning Time: 4.715 ms
 Execution Time: 0.281 ms
(18 rows)

