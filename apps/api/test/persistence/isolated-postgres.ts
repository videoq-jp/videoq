import pg from "pg";

export async function isolatedPostgres(databaseUrl: string, options: {includePublic?: boolean} = {}) {
  const schema = `contract_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}${options.includePublic ? ',public' : ''}`, max: 4 });
  const dispose = async () => {
    try { await pool.end(); }
    finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    return { pool, dispose };
  } catch (error) { await dispose(); throw error; }
}
