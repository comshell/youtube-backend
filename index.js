const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// --- TOKEN ENCRYPTION HELPERS ---
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;

function encryptToken(text) {
  let iv = crypto.randomBytes(IV_LENGTH);
  let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptToken(text) {
  let textParts = text.split(':');
  let iv = Buffer.from(textParts.shift(), 'hex');
  let encryptedText = Buffer.from(textParts.join(':'), 'hex');
  let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}
// ---------------------------------

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'openid',
      'email'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    let userEmail = null;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      userEmail = payload.email ? payload.email.toLowerCase() : null;
    }

    if (!userEmail) {
      return res.redirect('https://comshell.github.io/dashboard.html?error=no_email');
    }

    const { data: allowedData, error: allowedError } = await supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', userEmail)
      .single();

    if (allowedError || !allowedData) {
      console.log(`Unauthorized login attempt blocked for: ${userEmail}`);
      return res.redirect('https://comshell.github.io/dashboard.html?error=unauthorized');
    }

    if (tokens.refresh_token) {
      const encryptedToken = encryptToken(tokens.refresh_token);
      
      const { error } = await supabase
        .from('youtube_tokens')
        .upsert(
          { email: userEmail, refresh_token: encryptedToken, updated_at: new Date() },
          { onConflict: 'email' }
        );

      if (error) {
        console.error("Supabase save error:", error);
      }
    }

    res.redirect(`https://comshell.github.io/dashboard.html?linked=success&email=${encodeURIComponent(userEmail)}`);
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.redirect('https://comshell.github.io/dashboard.html?error=token_failed');
  }
});

app.post('/api/initiate-upload', async (req, res) => {
  try {
    const { title, description, fileSize, fileType, userEmail } = req.body;

    if (!userEmail) {
      return res.status(400).json({ error: "User email missing from upload request." });
    }

    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('email', userEmail.toLowerCase())
      .single();

    if (error || !data || !data.refresh_token) {
      return res.status(401).json({ error: "Connection expired, please tap 'Link YouTube Account' on your dashboard." });
    }

    const plainRefreshToken = decryptToken(data.refresh_token);
    oauth2Client.setCredentials({ refresh_token: plainRefreshToken });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    const actualFileType = fileType || 'video/*';
    const frontendOrigin = req.headers['origin-header'] || 'https://www.comshell.co.uk';

    const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: title || 'Verification Upload',
          description: description || 'Pending verification video submission.',
          categoryId: '22'
        },
        status: {
          privacyStatus: 'private'
        }
      },
      media: {
        mimeType: actualFileType,
        body: ''
      }
    }, {
      url: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      headers: {
        'X-Upload-Content-Length': fileSize || 0,
        'X-Upload-Content-Type': actualFileType,
        'Origin': frontendOrigin
      }
    });

    const uploadUrl = response.headers.location;
    res.json({ uploadUrl });

  } catch (err) {
    console.error("Error initiating upload session:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- UPLOAD COMPLETE NOTIFICATION ENDPOINT ---
app.post('/api/upload-complete', async (req, res) => {
  try {
    const { userEmail, title } = req.body;

    if (!userEmail) {
      return res.status(400).json({ error: "User email missing." });
    }

    const data = await resend.emails.send({
      from: 'ComShell SUP <onboarding@resend.dev>',
      to: [userEmail],
      subject: '✅New Video Awaiting Review!✅',
      html: `
        <div style="font-family: sans-serif; color: #0f172a; padding: 20px;">
          <h2 style="color: #2aa6ad;">Upload Successful!</h2>
          <p>Hello,</p>
          <p>The video <strong>"${title || 'Untitled Video'}"</strong> has just been successfully uploaded to YouTube through via ComShell's Safe Upload Pipeline. This video will remain PRIVATE and will not be accessible by the public until you change its visibility to PUBLIC or UNLISTED in the YouTube app.</p>
          <p style="margin-top: 20px; color: #475569; font-size: 0.9rem;">Thank you for using ComShell!</p>
        </div>
      `
    });

    console.log("Success email sent:", data);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending success email:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- HEALTH-CHECK ENDPOINT ---
app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabase.from('youtube_tokens').select('email').limit(1);
    if (error) {
      return res.status(500).json({ status: 'Database error', error: error.message });
    }
    res.status(200).json({ status: 'Alive and kicking!' });
  } catch (err) {
    res.status(500).json({ status: 'Error', error: err.message });
  }
});
// -----------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
