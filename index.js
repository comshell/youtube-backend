const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 1. Fetch the Google profile info to get the authenticated user's email address
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const userEmail = userInfo.data.email;

    if (!userEmail) {
      return res.redirect('https://comshell.github.io/dashboard.html?error=no_email');
    }

    // 2. Query Supabase to check if this email exists in your allowed_emails table
    const { data: allowedData, error: allowedError } = await supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', userEmail)
      .single();

    // 3. If the email is not found in the table, block them immediately!
    if (allowedError || !allowedData) {
      console.log(`Unauthorized login attempt blocked for: ${userEmail}`);
      return res.redirect('https://comshell.github.io/dashboard.html?error=unauthorized');
    }

    // 4. Authorized! Proceed to save the refresh token as normal
    if (tokens.refresh_token) {
      const { error } = await supabase
        .from('youtube_tokens')
        .upsert({ email: userEmail, refresh_token: tokens.refresh_token, updated_at: new Date() }, { onConflict: 'email' });

      if (error) {
        console.error("Supabase save error:", error);
      } else {
        console.log(`Refresh token successfully saved to Supabase for ${userEmail}!`);
      }
    }

    res.redirect('https://comshell.github.io/dashboard.html?linked=success');
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.redirect('https://comshell.github.io/dashboard.html?error=token_failed');
  }
});

app.post('/api/initiate-upload', async (req, res) => {
  try {
    const clientEmail = "comshell.master.zm@gmail.com";

    const { data, error } = await supabase
      .from('youtube_tokens')
      .select('refresh_token')
      .eq('email', clientEmail)
      .single();

    if (error || !data || !data.refresh_token) {
      return res.status(401).json({ error: "Connection expired, please tap 'Link YouTube Account' on your dashboard." });
    }

    oauth2Client.setCredentials({ refresh_token: data.refresh_token });

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    const { title, description, fileSize, fileType } = req.body;
    const actualFileType = fileType || 'video/*';
    const frontendOrigin = req.headers['origin-header'] || 'https://www.comshell.co.uk';

  const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {  // <--- Change 'resource' to 'requestBody' here!
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
        body: '' // Empty body to initialize session
      }
    }, {
      // Force the exact endpoint override for resumable upload initiation
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

// --- NEW HEALTH-CHECK ENDPOINT FOR SUPABASE WAKE-UP ---
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
// ----------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
