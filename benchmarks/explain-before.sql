=== Query 1: Dashboard /my-work (projects with inferred_status) ===
                                                                                  QUERY PLAN                                                                                   
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=32.14..32.26 rows=50 width=258) (actual time=0.348..0.359 rows=50 loops=1)
   ->  Sort  (cost=32.14..32.45 rows=124 width=258) (actual time=0.344..0.349 rows=50 loops=1)
         Sort Key: updated_at DESC
         Sort Method: top-N heapsort  Memory: 78kB
         ->  Seq Scan on documents d  (cost=0.00..28.02 rows=124 width=258) (actual time=0.024..0.231 rows=119 loops=1)
               Filter: ((deleted_at IS NULL) AND (document_type = ANY ('{project,issue}'::document_type[])) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid))
               Rows Removed by Filter: 138
 Planning Time: 3.943 ms
 Execution Time: 0.425 ms
(9 rows)

=== Query 2: Weeks list (sprints with counts) ===
                                                                                                                                                   QUERY PLAN                                                                                                                                                    
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=2240.52..2240.61 rows=36 width=282) (actual time=7.574..7.577 rows=35 loops=1)
   Sort Key: (((d.properties ->> 'sprint_number'::text))::integer) DESC
   Sort Method: quicksort  Memory: 43kB
   ->  Seq Scan on documents d  (cost=0.00..2239.59 rows=36 width=282) (actual time=0.277..7.509 rows=35 loops=1)
         Filter: ((deleted_at IS NULL) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND (document_type = 'sprint'::document_type))
         Rows Removed by Filter: 222
         SubPlan 1
           ->  Aggregate  (cost=30.03..30.04 rows=1 width=8) (actual time=0.106..0.106 rows=1 loops=35)
                 ->  Seq Scan on documents i  (cost=0.00..30.03 rows=1 width=0) (actual time=0.104..0.104 rows=0 loops=35)
                       Filter: ((deleted_at IS NULL) AND (document_type = 'issue'::document_type) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND ((properties ->> 'sprint_number'::text) = (d.properties ->> 'sprint_number'::text)))
                       Rows Removed by Filter: 257
         SubPlan 2
           ->  Aggregate  (cost=31.37..31.38 rows=1 width=8) (actual time=0.104..0.104 rows=1 loops=35)
                 ->  Seq Scan on documents i_1  (cost=0.00..31.37 rows=1 width=0) (actual time=0.102..0.102 rows=0 loops=35)
                       Filter: ((deleted_at IS NULL) AND (document_type = 'issue'::document_type) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND ((properties ->> 'state'::text) = 'done'::text) AND ((properties ->> 'sprint_number'::text) = (d.properties ->> 'sprint_number'::text)))
                       Rows Removed by Filter: 257
 Planning Time: 0.469 ms
 Execution Time: 7.644 ms
(18 rows)

=== Query 3: Issues list ===
                                                                         QUERY PLAN                                                                          
-------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=31.67..31.92 rows=100 width=594) (actual time=0.118..0.131 rows=100 loops=1)
   ->  Sort  (cost=31.67..31.94 rows=108 width=594) (actual time=0.118..0.123 rows=100 loops=1)
         Sort Key: updated_at DESC
         Sort Method: quicksort  Memory: 77kB
         ->  Seq Scan on documents d  (cost=0.00..28.02 rows=108 width=594) (actual time=0.008..0.073 rows=104 loops=1)
               Filter: ((deleted_at IS NULL) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND (document_type = 'issue'::document_type))
               Rows Removed by Filter: 153
 Planning Time: 0.146 ms
 Execution Time: 0.145 ms
(9 rows)

=== Query 4: Sprint detail (single week with subqueries) ===
                                                                                                                                                QUERY PLAN                                                                                                                                                 
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Index Scan using documents_pkey on documents d  (cost=0.15..69.59 rows=1 width=606) (actual time=0.162..0.163 rows=1 loops=1)
   Index Cond: (id = 'ecf95e4c-1df9-4576-8dc3-5fc20f1b850a'::uuid)
   SubPlan 1
     ->  Aggregate  (cost=30.03..30.04 rows=1 width=8) (actual time=0.077..0.077 rows=1 loops=1)
           ->  Seq Scan on documents i  (cost=0.00..30.03 rows=1 width=0) (actual time=0.076..0.076 rows=0 loops=1)
                 Filter: ((deleted_at IS NULL) AND (document_type = 'issue'::document_type) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND ((properties ->> 'sprint_number'::text) = (d.properties ->> 'sprint_number'::text)))
                 Rows Removed by Filter: 257
   SubPlan 2
     ->  Aggregate  (cost=31.37..31.38 rows=1 width=8) (actual time=0.073..0.073 rows=1 loops=1)
           ->  Seq Scan on documents i_1  (cost=0.00..31.37 rows=1 width=0) (actual time=0.072..0.072 rows=0 loops=1)
                 Filter: ((deleted_at IS NULL) AND (document_type = 'issue'::document_type) AND (workspace_id = '498359b5-5748-4e42-be9d-a83ebe6af31e'::uuid) AND ((properties ->> 'state'::text) = 'done'::text) AND ((properties ->> 'sprint_number'::text) = (d.properties ->> 'sprint_number'::text)))
                 Rows Removed by Filter: 257
 Planning Time: 0.237 ms
 Execution Time: 0.187 ms
(14 rows)

=== Query 5: Auth middleware (session + membership) ===
                                                        QUERY PLAN                                                         
---------------------------------------------------------------------------------------------------------------------------
 Nested Loop  (cost=0.14..9.33 rows=1 width=74) (actual time=0.008..0.008 rows=0 loops=1)
   ->  Seq Scan on sessions s  (cost=0.00..1.10 rows=1 width=40) (actual time=0.008..0.008 rows=0 loops=1)
         Filter: ((id = 'test-session-id-that-does-not-exist'::text) AND (last_activity > (now() - '00:15:00'::interval)))
         Rows Removed by Filter: 5
   ->  Index Scan using users_pkey on users u  (cost=0.14..8.16 rows=1 width=50) (never executed)
         Index Cond: (id = s.user_id)
 Planning Time: 1.729 ms
 Execution Time: 0.021 ms
(8 rows)

