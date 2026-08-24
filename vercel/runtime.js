let agentPromise = null;

function installPostgresAdapter() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required on Vercel. Use the Supabase pooled Postgres connection string.');
  }

  const databasePath = require.resolve('../database/db');
  const databaseModule = require(databasePath);
  const { createPostgresDatabaseClass } = require('../database/postgres-db');
  const PostgresDatabase = createPostgresDatabaseClass(databaseModule.Database);

  // A web-function cold start must never mark jobs owned by a durable worker as
  // interrupted. The worker remains the authority for job lifecycle recovery.
  PostgresDatabase.prototype.markInterruptedJobs = async function skipWebRecovery() {
    this.logger.info('Skipping interrupted-job recovery in Vercel web runtime');
  };

  databaseModule.Database = PostgresDatabase;
}

function installEnvironmentCredentials() {
  const { CredentialManager } = require('../utils/credential-manager');
  const originalLoadCredentials = CredentialManager.prototype.loadCredentials;
  const originalLoadTokens = CredentialManager.prototype.loadTokens;

  CredentialManager.prototype.loadCredentials = async function loadVercelCredentials() {
    await originalLoadCredentials.call(this);

    if (process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET) {
      this.credentials.youtube = {
        ...(this.credentials.youtube || {}),
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uris: [process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:8080/oauth2callback']
      };
    }
  };

  CredentialManager.prototype.loadTokens = async function loadVercelTokens() {
    await originalLoadTokens.call(this);

    if (process.env.YOUTUBE_REFRESH_TOKEN) {
      const defaultScopes = [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
        'https://www.googleapis.com/auth/youtube.force-ssl'
      ].join(' ');

      this.tokens.youtube = {
        ...(this.tokens.youtube || {}),
        refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
        token_type: 'Bearer',
        scope: process.env.YOUTUBE_TOKEN_SCOPE || defaultScopes
      };

      if (process.env.YOUTUBE_ACCESS_TOKEN) {
        this.tokens.youtube.access_token = process.env.YOUTUBE_ACCESS_TOKEN;
      }
      if (process.env.YOUTUBE_TOKEN_EXPIRY_DATE) {
        this.tokens.youtube.expiry_date = Number(process.env.YOUTUBE_TOKEN_EXPIRY_DATE);
      }
    }
  };
}

function installServerlessPatches() {
  // A Vercel Function is request-driven, so a process-local node-cron scheduler
  // is not a reliable scheduling mechanism. A dedicated Vercel Cron/worker
  // should drive scheduled jobs instead.
  const { DailyAutomation } = require('../schedules/daily-automation');
  DailyAutomation.prototype.initialize = async function initializeForVercel() {
    this.isEnabled = false;
    this.logger.info('Persistent node-cron scheduler disabled in Vercel web runtime');
    return true;
  };

  // These initializers create directories beside the deployed source bundle.
  // The Vercel web runtime is intentionally a control plane; media generation
  // belongs in a durable worker with writable/persistent asset storage.
  const { ProductionManagementAgent } = require('../agents/production-management-agent');
  ProductionManagementAgent.prototype.setupDirectories = async function skipVercelDirectories() {
    this.logger.info('Skipping local production directory setup in Vercel web runtime');
  };

  const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
  ThumbnailDesignerAgent.prototype.ensureTemplatesDirectory = async function skipVercelThumbnailDirectories() {
    this.logger.info('Skipping local thumbnail directory setup in Vercel web runtime');
  };
}

function workerUnavailableError() {
  const error = new Error(
    'Media generation is disabled in the Vercel web runtime. Configure the durable media worker before generating or publishing content.'
  );
  error.status = 503;
  error.code = 'VERCEL_MEDIA_WORKER_REQUIRED';
  return error;
}

function protectHeavyWorkerMethods(agent) {
  if (process.env.ENABLE_VERCEL_MEDIA_WORKER === 'true') return;

  agent.startGenerationJob = async () => { throw workerUnavailableError(); };
  agent.resumeGenerationJob = async () => { throw workerUnavailableError(); };
  agent.queueScheduledContent = async () => { throw workerUnavailableError(); };

  if (agent.agents?.publishing?.publishContent) {
    agent.agents.publishing.publishContent = async () => { throw workerUnavailableError(); };
  }
}

async function createAgent() {
  installPostgresAdapter();
  installEnvironmentCredentials();
  installServerlessPatches();

  const { YouTubeAutomationAgent } = require('../index');
  const agent = new YouTubeAutomationAgent();
  const initialized = await agent.initialize();

  if (!initialized) {
    throw new Error('YouTube Automation Agent failed to initialize in the Vercel runtime');
  }

  protectHeavyWorkerMethods(agent);
  return agent;
}

async function getAgent() {
  if (!agentPromise) {
    agentPromise = createAgent().catch(error => {
      agentPromise = null;
      throw error;
    });
  }
  return agentPromise;
}

module.exports = { getAgent };
