// The namespace that owns the courses at the root of the content checkout, and
// the workspace the Library opens when the URL names none. config.json's
// `owner` reaches the server as RUNNER_OWNER.
const owner = process.env.RUNNER_OWNER || 'me';
// The value is interpolated into schema migrations, so it is validated here.
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(owner)) throw new Error('RUNNER_OWNER must be a lowercase namespace name');
export const defaultWorkspace = owner;
