const nodemailer = require('nodemailer');
const env = require('../config/env');

function mailConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

let transporter;

async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) return false;
  transporter ||= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
  });
  await transporter.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to, subject, text });
  return true;
}

module.exports = { sendMail, mailConfigured };
