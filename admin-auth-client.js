(() => {
  async function request(path, method = 'GET', body) {
    const response = await fetch(`/api/admin/${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      await response.text();
      throw new Error(`Admin service unavailable (HTTP ${response.status}).`);
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Admin request failed (HTTP ${response.status}).`);
    return data;
  }

  async function current() {
    try { return (await request('me')).admin; }
    catch { return null; }
  }

  function login(email, password) {
    return request('login', 'POST', { email, password });
  }

  function logout() {
    return request('logout', 'POST', {});
  }

  async function requirePage() {
    const admin = await current();
    if (admin) {
      document.body.classList.add('nba-admin-authorized');
      return admin;
    }
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    location.replace(`/admin-console.html?returnTo=${encodeURIComponent(returnTo)}`);
    return null;
  }

  window.NBAAdminAuth = { current, login, logout, requirePage };
})();
