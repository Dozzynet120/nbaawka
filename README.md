# NBA AWKA Website Update

Mobile navigation improvements were made across the website.

## Member portal backend

The `backend/` folder contains a Node.js/PostgreSQL member API configured for Vercel Functions. Login, registration, email verification, and password reset on `membershiplogin.html` and `join.html` call this API; `dashboard.html` validates sessions through it. See `backend/README.md` for deployment details.

The backend is not live until the Vercel project, PostgreSQL, Resend sender domain, and initial admin email are configured. The initial admin can invite up to three more admins from `admin-console.html`. Applications remain pending until the applicant verifies their email and any one admin approves. Members register themselves; no roster import is required.
