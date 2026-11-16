"""Fixed-source read-only SQL allowlist for final vector authority inventory."""
import re
from d1_resource_fence_control import SOURCE
from d1_resource_fence_transport import CloudflareFenceQuery
from d1_resource_vector_plan import AUTHORITY_SQL

COUNT_SQL = 'SELECT CAST(count(*) AS TEXT) AS rows FROM (' + AUTHORITY_SQL + ')'
PAGE_PREFIX = AUTHORITY_SQL + ' ORDER BY dimensions,vector_id,scene_id,revision LIMIT 100 OFFSET '


class VectorAuthorityQuery(CloudflareFenceQuery):
    def __call__(self, sql):
        if not isinstance(sql, str) or (sql != COUNT_SQL and not (sql.startswith(PAGE_PREFIX)
                and re.fullmatch(r'0|[1-9][0-9]{0,18}', sql[len(PAGE_PREFIX):]))):
            raise ValueError('RESOURCE_VECTOR_AUTHORITY_QUERY_REFUSED')
        return self._request(SOURCE, sql)
