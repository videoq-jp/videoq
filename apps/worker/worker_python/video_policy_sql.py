"""Compile processing policy inside the adapter's original atomic SQL fences."""


class VideoPolicySql:
    def all(self, *terms: str) -> str:
        return '(' + ' AND '.join(f'({term})' for term in terms) + ')'

    def any(self, *terms: str) -> str:
        return '(' + ' OR '.join(f'({term})' for term in terms) + ')'

    def negate(self, term: str) -> str:
        return f'NOT ({term})'

    def choose(self, condition: str, yes: str, no: str) -> str:
        return f'CASE WHEN {condition} THEN {yes} ELSE {no} END'

    def literal(self, value: str) -> str:
        # Only closed application-owned state values use this method. Request
        # values and driver operands remain placeholders supplied by the adapter.
        return "'" + value.replace("'", "''") + "'"

    def number(self, value: int) -> str:
        return str(value)

    def add(self, left: str, right: str) -> str:
        return f'({left})+({right})'

    def subtract(self, left: str, right: str) -> str:
        return f'({left})-({right})'

    def multiply(self, left: str, right: int) -> str:
        return f'({left})*{right}'

    def at_most(self, left: str, right: str) -> str:
        return f'({left})<=({right})'

    def is_unlimited(self, value: str) -> str:
        return f'({value}) IS NULL'


VIDEO_POLICY_SQL = VideoPolicySql()
