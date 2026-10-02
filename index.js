const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Configure Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 1. Health check endpoint for Render
app.get('/', (req, res) => {
  res.json({ status: "YouTube Verification Backend is live!" });
});

// 2. Generate Google OAuth Login URL
app.get('/auth/google', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Required to get a refresh token
    scope: scopes,
    prompt: 'consent' // Forces consent screen to ensure refresh token is provided
  });

  res.json({ url });
});

// 3. OAuth Callback: Exchange code for tokens (Stubbed for database storage later)
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // TODO: In the next steps, we will save `tokens.refresh_token` into Supabase tied to this user.
    console.log("Tokens acquired successfully:", tokens);

    // Redirect user back to your frontend dashboard with success flag
    res.redirect('https://comshell.github.io/dashboard.html?linked=success');
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.redirect('https://comshell.github.io/dashboard.html?error=token_failed');
  }
});

// 4. Request Direct-to-YouTube Resumable Upload Session URL
app.post('/api/create-upload-session', async (req, res) => {
  const { refreshToken, title, description, fileSize } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ 
      error: "Mom's connection expired, she needs to tap 'Relink YouTube' on her dashboard." 
    });
  }

  try {
    // Set credentials using the user's saved refresh token
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Initialize YouTube service
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    // Request a resumable upload session from Google
    // Note: We set privacyStatus to 'private' as per your verification pipeline requirement!
    const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: title || 'Pending Verification Video',
          description: description || 'Uploaded via Creator Launch Pad verification pipeline.',
          categoryId: '22' // People & Blogs default
        },
        status: {
          privacyStatus: 'private', // Sits as private until second person verifies
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: null // We just want the session URI header back, browser will stream the body
      }
    }, {
      // This tells Google we want a resumable upload URI returned in headers
      headers: {
        'X-Upload-Content-Length': fileSize,
        'X-Upload-Content-Type': 'video/*'
      }
    });

    // Google returns the resumable session URL in the Location header
    const uploadUrl = response.headers.location;

    if (!uploadUrl) {
      throw new Error("Failed to retrieve upload session URL from Google.");
    }

    res.json({ uploadUrl });

  } catch (error) {
    console.error("Resumable upload session error:", error);
    
    // Graceful error handler checking for expired or revoked tokens
    if (error.code === 401 || error.code === 403 || (error.message && error.message.includes('invalid_grant'))) {
      return res.status(401).json({ 
        error: "Mom's connection expired, she needs to tap 'Relink YouTube' on her dashboard." 
      });
    }

    res.status(500).json({ error: "Failed to initialize upload session. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
