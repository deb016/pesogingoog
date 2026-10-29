// mailer.js
// Sends account, profile-review, and staff follow-up emails via Brevo's transactional
// email HTTP API (https://api.brevo.com/v3/smtp/email) using Node's built-in
// fetch — no nodemailer, no SMTP socket connection. This matters if you deploy
// this backend on Vercel: Vercel's serverless functions don't reliably support
// long-lived outbound SMTP connections (the kind Gmail SMTP needs), but a plain
// HTTPS POST request works everywhere, including there.
//
// Configure with environment variables so no secrets are hard-coded in the repo:
//
//   BREVO_API_KEY       your Brevo API key (Brevo dashboard -> Settings (gear icon)
//                        -> SMTP & API -> API Keys -> Generate a new API key).
//                        Starts with "xkeysib-...".
//   BREVO_SENDER_EMAIL   the FROM address — must be a verified sender in Brevo
//                        (Brevo dashboard -> Senders, Domains & Dedicated IPs).
//   BREVO_SENDER_NAME    display name for the FROM address (optional, defaults
//                        to "PESO Gingoog City").
//   APP_BASE_URL         the URL of the deployed frontend, e.g. http://localhost:5173
//                        (used to build the verification/reset links the user clicks)
//
// BREVO_API_KEY and BREVO_SENDER_EMAIL must be configured in the environment.
"use strict";

const APP_BASE_URL = (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
const LOGO_URL = process.env.BREVO_LOGO_URL || `${APP_BASE_URL}/peso-logo.png`;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const SENDER_NAME = process.env.BREVO_SENDER_NAME || "PESO Gingoog City";
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

function isConfigured() {
  return !!(BREVO_API_KEY && SENDER_EMAIL);
}

async function sendMail({ to, subject, html, text }) {
  if (!isConfigured()) {
    const error = "Email not sent: configure BREVO_API_KEY and BREVO_SENDER_EMAIL in the backend environment.";
    console.error(error);
    return { sent: false, error };
  }

  let res;
  try {
    res = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
  } catch (err) {
    console.error("Brevo request failed (network error):", err.message);
    return { sent: false, error: err.message };
  }

  if (!res.ok) {
    // Brevo returns a JSON body describing what went wrong (bad API key, sender
    // not verified, etc.) — surface it in the server log so it's easy to diagnose,
    // without throwing and breaking whatever triggered the email (registration,
    // password reset request, ...) since those should still succeed either way.
    const body = await res.text().catch(() => "");
    console.error(`Brevo API error (${res.status}):`, body);
    return { sent: false, error: body };
  }
  return { sent: true };
}

function emailHtml({ heading, message, buttonLabel, link, expiry }) {
  return `
    <!doctype html>
    <html>
      <body style="margin:0;padding:0;background:#f2f5f7;color:#202833;font-family:Arial,Helvetica,sans-serif">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f7;padding:32px 12px">
          <tr><td align="center">
            <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e7eb">
              <tr><td align="center" style="padding:32px 28px 20px;border-top:5px solid #1555a5">
                <img src="${LOGO_URL}" alt="PESO Gingoog City" width="88" height="88" style="display:block;width:88px;height:88px;object-fit:contain;border:0">
                <p style="margin:16px 0 0;color:#38516e;font-size:12px;font-weight:bold;letter-spacing:1px">PESO GINGOOG CITY</p>
              </td></tr>
              <tr><td style="padding:12px 36px 36px">
                <h1 style="margin:0 0 18px;color:#173f70;font-size:25px;line-height:1.3;text-align:center">${heading}</h1>
                <p style="margin:0 0 14px;font-size:16px;line-height:1.6">${message}</p>
                <p style="margin:0 0 24px;color:#596575;font-size:15px;line-height:1.6">Use the button below to continue:</p>
                <table role="presentation" cellspacing="0" cellpadding="0" align="center">
                  <tr><td bgcolor="#1555a5" style="border-radius:4px">
                    <a href="${link}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none">${buttonLabel}</a>
                  </td></tr>
                </table>
                <p style="margin:24px 0 6px;color:#697586;font-size:13px;line-height:1.5">If the button does not work, copy this link into your browser:</p>
                <p style="margin:0;word-break:break-all;font-size:13px;line-height:1.5"><a href="${link}" style="color:#1555a5">${link}</a></p>
                <p style="margin:22px 0 0;color:#697586;font-size:13px;line-height:1.5">${expiry}</p>
              </td></tr>
              <tr><td style="padding:18px 28px;background:#f7f9fb;border-top:1px solid #e7ebef;color:#697586;font-size:12px;line-height:1.5;text-align:center">
                Public Employment Service Office - Gingoog City
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
}

async function sendStaffFollowUpEmail({ to, seekerName, message, vacancyTitle }) {
    const safeName = escapeHtml(seekerName || "there");
    const safeVacancyTitle = escapeHtml(vacancyTitle || "your job application");
    const safeMessage = escapeHtml(message).replace(/\r?\n/g, "<br>");
    return sendMail({
      to,
      subject: "PESO Gingoog City: Hired — Referral Letter Follow-Up",
      text: `Hello ${seekerName || "there"},\n\n${message}\n\nRegarding: ${vacancyTitle || "your job application"}\n\nPESO Gingoog City`,
      html: `
        <!doctype html>
        <html>
          <body style="margin:0;padding:24px;background:#f2f5f7;color:#202833;font-family:Arial,Helvetica,sans-serif">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e7eb">
              <tr><td style="padding:24px 28px;border-top:5px solid #1555a5">
                <p style="margin:0 0 20px;color:#38516e;font-size:12px;font-weight:bold;letter-spacing:1px">PESO GINGOOG CITY</p>
                <h1 style="margin:0 0 20px;color:#173f70;font-size:22px">Message from PESO Gingoog City</h1>
                <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello ${safeName},</p>
                <p style="margin:0;font-size:15px;line-height:1.7">${safeMessage}</p>
                <p style="margin:24px 0 0;color:#596575;font-size:13px;line-height:1.5"><strong>Regarding:</strong> ${safeVacancyTitle}</p>
              </td></tr>
              <tr><td style="padding:16px 28px;background:#f7f9fb;border-top:1px solid #e7ebef;color:#697586;font-size:12px;line-height:1.5;text-align:center">
                Public Employment Service Office - Gingoog City
              </td></tr>
            </table>
          </body>
        </html>`,
    });
}

async function sendProfileReviewEmail({ to, name, role, status, remarks }) {
  const roleLabel = role === "employer" ? "Employer" : "Job Seeker";
  const safeName = escapeHtml(name || roleLabel);
  const safeRemarks = remarks ? escapeHtml(remarks).replace(/\r?\n/g, "<br>") : "";
  const messages = {
    verified: {
      subject: "Your PESO Gingoog City profile has been verified",
      heading: "Profile verified",
      message: role === "employer"
        ? "Your establishment profile has been verified. You can now post job vacancies for PESO approval."
        : "Your profile has been verified. You can now view matching job opportunities and apply for available jobs.",
    },
    returned_for_completion: {
      subject: "Action needed: update your PESO Gingoog City profile",
      heading: "Profile returned for completion",
      message: "PESO Staff reviewed your profile and returned it for updates. Please sign in, review the remarks below, update your profile, and submit it again for verification.",
    },
    rejected: {
      subject: "Update about your PESO Gingoog City profile",
      heading: "Profile not approved",
      message: "PESO Staff did not approve your profile. Please contact the PESO office if you need assistance.",
    },
  };
  const notification = messages[status];
  if (!notification) throw new Error(`Unsupported profile review email status: ${status}`);

  const remarksHtml = safeRemarks
    ? `<div style="margin-top:20px;padding:14px;background:#f7f9fb;border-left:3px solid #1555a5"><strong>Remarks from PESO Staff</strong><p style="margin:8px 0 0;line-height:1.6">${safeRemarks}</p></div>`
    : "";
  const remarksText = remarks ? `\n\nRemarks from PESO Staff:\n${remarks}` : "";
  const dashboardUrl = APP_BASE_URL;
  return sendMail({
    to,
    subject: notification.subject,
    text: `Hello ${name || roleLabel},\n\n${notification.message}${remarksText}\n\nSign in to your account: ${dashboardUrl}\n\nPESO Gingoog City`,
    html: `
      <!doctype html>
      <html>
        <body style="margin:0;padding:24px;background:#f2f5f7;color:#202833;font-family:Arial,Helvetica,sans-serif">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e7eb">
            <tr><td style="padding:24px 28px;border-top:5px solid #1555a5">
              <p style="margin:0 0 20px;color:#38516e;font-size:12px;font-weight:bold;letter-spacing:1px">PESO GINGOOG CITY</p>
              <h1 style="margin:0 0 20px;color:#173f70;font-size:22px">${notification.heading}</h1>
              <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello ${safeName},</p>
              <p style="margin:0;font-size:15px;line-height:1.7">${notification.message}</p>
              ${remarksHtml}
              <p style="margin:24px 0 0;font-size:14px"><a href="${escapeHtml(dashboardUrl)}" style="color:#1555a5">Sign in to your PESO account</a></p>
            </td></tr>
            <tr><td style="padding:16px 28px;background:#f7f9fb;border-top:1px solid #e7ebef;color:#697586;font-size:12px;line-height:1.5;text-align:center">
              Public Employment Service Office - Gingoog City
            </td></tr>
          </table>
        </body>
      </html>`,
  });
}

async function sendReferralInvitationEmail({ to, name, vacancyTitle, employer, matchScore }) {
  const safeName = escapeHtml(name || "there");
  const safeTitle = escapeHtml(vacancyTitle || "a job vacancy");
  const safeEmployer = escapeHtml(employer || "an employer");
  const dashboardUrl = escapeHtml(APP_BASE_URL);
  const message = `PESO Staff has referred you to review the ${vacancyTitle || "job"} position at ${employer || "an employer"}. This is an invitation, not an application. Sign in to your PESO account to review the vacancy and choose whether to apply.`;
  return sendMail({
    to,
    subject: `PESO Gingoog City: Job referral for ${vacancyTitle || "you"}`,
    text: `Hello ${name || "there"},\n\n${message}\n\nMatch score: ${matchScore}%\n\nSign in to your account: ${APP_BASE_URL}\n\nPESO Gingoog City`,
    html: `
      <!doctype html>
      <html>
        <body style="margin:0;padding:24px;background:#f2f5f7;color:#202833;font-family:Arial,Helvetica,sans-serif">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e7eb">
            <tr><td style="padding:24px 28px;border-top:5px solid #1555a5">
              <p style="margin:0 0 20px;color:#38516e;font-size:12px;font-weight:bold;letter-spacing:1px">PESO GINGOOG CITY</p>
              <h1 style="margin:0 0 20px;color:#173f70;font-size:22px">A PESO Staff referral is waiting for you</h1>
              <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello ${safeName},</p>
              <p style="margin:0;font-size:15px;line-height:1.7">PESO Staff recommends that you review <strong>${safeTitle}</strong> at <strong>${safeEmployer}</strong>.</p>
              <p style="margin:16px 0;font-size:14px;line-height:1.6">Match score: <strong>${Number(matchScore)}%</strong></p>
              <p style="margin:0;font-size:14px;line-height:1.6">This is an invitation, not an application. Sign in to review the vacancy and choose whether to apply.</p>
              <p style="margin:24px 0 0;font-size:14px"><a href="${dashboardUrl}" style="color:#1555a5">Sign in to your PESO account</a></p>
            </td></tr>
            <tr><td style="padding:16px 28px;background:#f7f9fb;border-top:1px solid #e7ebef;color:#697586;font-size:12px;line-height:1.5;text-align:center">
              Public Employment Service Office - Gingoog City
            </td></tr>
          </table>
        </body>
      </html>`,
  });
}

async function sendVacancyReviewEmail({ to, name, vacancyTitle, status, remarks }) {
  const review = {
    approved: {
      subject: "Your PESO Gingoog City vacancy has been approved",
      heading: "Vacancy approved",
      message: "PESO Staff approved your job vacancy. It is now visible to job seekers.",
    },
    returned_for_completion: {
      subject: "Action needed: update your PESO Gingoog City vacancy",
      heading: "Vacancy returned for changes",
      message: "PESO Staff reviewed your job vacancy and returned it for changes. Sign in to review the remarks, edit the vacancy, and resubmit it for approval.",
    },
    rejected: {
      subject: "Update about your PESO Gingoog City vacancy",
      heading: "Vacancy not approved",
      message: "PESO Staff did not approve your job vacancy. You may edit it and resubmit it for approval.",
    },
  }[status];
  if (!review) throw new Error(`Unsupported vacancy review email status: ${status}`);

  const safeName = escapeHtml(name || "Employer");
  const safeTitle = escapeHtml(vacancyTitle || "your job vacancy");
  const safeRemarks = remarks ? escapeHtml(remarks).replace(/\r?\n/g, "<br>") : "";
  const remarksHtml = safeRemarks
    ? `<div style="margin-top:20px;padding:14px;background:#f7f9fb;border-left:3px solid #1555a5"><strong>Remarks from PESO Staff</strong><p style="margin:8px 0 0;line-height:1.6">${safeRemarks}</p></div>`
    : "";
  const remarksText = remarks ? `\n\nRemarks from PESO Staff:\n${remarks}` : "";
  const dashboardUrl = escapeHtml(APP_BASE_URL);
  return sendMail({
    to,
    subject: review.subject,
    text: `Hello ${name || "Employer"},\n\n${review.message}\n\nVacancy: ${vacancyTitle || "your job vacancy"}${remarksText}\n\nSign in to your account: ${APP_BASE_URL}\n\nPESO Gingoog City`,
    html: `
      <!doctype html>
      <html>
        <body style="margin:0;padding:24px;background:#f2f5f7;color:#202833;font-family:Arial,Helvetica,sans-serif">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e7eb">
            <tr><td style="padding:24px 28px;border-top:5px solid #1555a5">
              <p style="margin:0 0 20px;color:#38516e;font-size:12px;font-weight:bold;letter-spacing:1px">PESO GINGOOG CITY</p>
              <h1 style="margin:0 0 20px;color:#173f70;font-size:22px">${review.heading}</h1>
              <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hello ${safeName},</p>
              <p style="margin:0;font-size:15px;line-height:1.7">${review.message}</p>
              <p style="margin:16px 0 0;font-size:14px;line-height:1.6"><strong>Vacancy:</strong> ${safeTitle}</p>
              ${remarksHtml}
              <p style="margin:24px 0 0;font-size:14px"><a href="${dashboardUrl}" style="color:#1555a5">Sign in to your PESO account</a></p>
            </td></tr>
            <tr><td style="padding:16px 28px;background:#f7f9fb;border-top:1px solid #e7ebef;color:#697586;font-size:12px;line-height:1.5;text-align:center">
              Public Employment Service Office - Gingoog City
            </td></tr>
          </table>
        </body>
      </html>`,
  });
}

async function sendVerificationEmail(email, token) {
  const link = `${APP_BASE_URL}/?verify=${encodeURIComponent(token)}`;
  return sendMail({
    to: email,
    subject: "Verify your PESO Gingoog City account",
    text: `Welcome to the PESO Gingoog City Job Matching System!\n\nPlease verify your Gmail address by opening this link:\n${link}\n\nThis link expires in 24 hours. If you didn't create this account, you can ignore this email.`,
    html: emailHtml({
      heading: "Verify your Gmail address",
      message: "Welcome to the PESO Gingoog City Job Matching and Employment Management System. Please confirm that this is your email address.",
      buttonLabel: "Verify Email Address",
      link,
      expiry: "This link expires in 24 hours. If you did not create this account, you can ignore this email.",
    }),
  });
}

async function sendPasswordResetEmail(email, token) {
  const link = `${APP_BASE_URL}/?reset=${encodeURIComponent(token)}`;
  return sendMail({
    to: email,
    subject: "Reset your PESO Gingoog City password",
    text: `We received a request to reset your PESO Gingoog City account password.\n\nOpen this link to choose a new password:\n${link}\n\nThis link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email — your password will not change.`,
    html: emailHtml({
      heading: "Reset your password",
      message: "We received a request to reset the password for your PESO Gingoog City account.",
      buttonLabel: "Reset Password",
      link,
      expiry: "This link expires in 1 hour and can only be used once. If you did not request this, you can ignore this email.",
    }),
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendStaffFollowUpEmail,
  sendProfileReviewEmail,
  sendReferralInvitationEmail,
  sendVacancyReviewEmail,
};
