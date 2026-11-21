import os
import re
import pytest

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "supabase_schema.sql")


def test_supabase_schema_rls_policies_are_strictly_isolated():
    """
    Topic 3: Verify Supabase schema RLS guarantees that User A cannot read,
    modify, or delete User B's data, and anon role is completely restricted.
    """
    assert os.path.exists(SCHEMA_PATH), f"Schema file not found at {SCHEMA_PATH}"
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        sql = f.read()

    # 1. Row Level Security must be enabled and enforced
    assert re.search(r"ALTER\s+TABLE\s+public\.user_portfolios\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY", sql, re.IGNORECASE), \
        "public.user_portfolios must have ENABLE ROW LEVEL SECURITY"
    assert re.search(r"ALTER\s+TABLE\s+public\.user_portfolios\s+FORCE\s+ROW\s+LEVEL\s+SECURITY", sql, re.IGNORECASE), \
        "public.user_portfolios must have FORCE ROW LEVEL SECURITY"

    # 2. Permissions must be revoked from anon and explicitly granted only to authenticated
    assert re.search(r"REVOKE\s+ALL\s+ON\s+public\.user_portfolios\s+FROM\s+anon", sql, re.IGNORECASE), \
        "Must REVOKE ALL ON public.user_portfolios FROM anon"
    assert re.search(r"GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.user_portfolios\s+TO\s+authenticated", sql, re.IGNORECASE), \
        "Must GRANT CRUD ON public.user_portfolios TO authenticated"

    # 3. Default user_id should be auth.uid() to prevent spoofing
    assert re.search(r"user_id\s+UUID\s+NOT\s+NULL\s+DEFAULT\s+auth\.uid\(\)", sql, re.IGNORECASE), \
        "user_id must default to auth.uid()"

    # 4. SELECT policy must restrict to authenticated user_id
    select_match = re.search(
        r'CREATE\s+POLICY\s+"Users can view their own portfolios"\s+ON\s+public\.user_portfolios\s+FOR\s+SELECT\s+TO\s+authenticated\s+USING\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)',
        sql,
        re.IGNORECASE
    )
    assert select_match, "SELECT policy must restrict USING (auth.uid() = user_id)"

    # 5. INSERT policy must restrict WITH CHECK (auth.uid() = user_id)
    insert_match = re.search(
        r'CREATE\s+POLICY\s+"Users can insert their own portfolios"\s+ON\s+public\.user_portfolios\s+FOR\s+INSERT\s+TO\s+authenticated\s+WITH\s+CHECK\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)',
        sql,
        re.IGNORECASE
    )
    assert insert_match, "INSERT policy must restrict WITH CHECK (auth.uid() = user_id)"

    # 6. UPDATE policy must restrict both USING and WITH CHECK to prevent tampering with other users or transferring ownership
    update_match = re.search(
        r'CREATE\s+POLICY\s+"Users can update their own portfolios"\s+ON\s+public\.user_portfolios\s+FOR\s+UPDATE\s+TO\s+authenticated\s+USING\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)\s+WITH\s+CHECK\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)',
        sql,
        re.IGNORECASE
    )
    assert update_match, "UPDATE policy must restrict both USING and WITH CHECK"

    # 7. DELETE policy must restrict USING (auth.uid() = user_id)
    delete_match = re.search(
        r'CREATE\s+POLICY\s+"Users can delete their own portfolios"\s+ON\s+public\.user_portfolios\s+FOR\s+DELETE\s+TO\s+authenticated\s+USING\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)',
        sql,
        re.IGNORECASE
    )
    assert delete_match, "DELETE policy must restrict USING (auth.uid() = user_id)"
