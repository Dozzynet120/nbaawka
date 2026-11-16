export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  res.setHeader('Set-Cookie', 'nba_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  return res.status(200).json({ message: 'Signed out.' });
}
