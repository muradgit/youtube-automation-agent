let agentPromise = null;

function installPostgresAdapter() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required on Vercel. Use the Supabase pooled Postgres connection string.');
  }

  const databasePath = require.resolve('../database/db');
  const databaseModule = require(databasePath);
  const { createPostgresDatabaseClass } = require('../database/postgres-db');
  databaseModule.Database = createPostgresDatabaseClass(databaseModule.Database);
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
