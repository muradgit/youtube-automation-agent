const { getAgent } = require('../vercel/runtime');

module.exports = async function handler(req, res) {
  try {
    const agent = await getAgent();
    return agent.app(req, res);
  } catch (error) {
    console.error('Vercel runtime initialization failed:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: 'Application initialization failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
    return undefined;
  }
};
