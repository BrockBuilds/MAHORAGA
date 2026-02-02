module.exports = {
  apps: [
    {
      name: "mahoraga-api",
      script: "./agent-demo.mjs",
      cwd: "/home/brock/clawd/projects/mahoraga",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development"
      }
    },
    {
      name: "mahoraga-dashboard",
      script: "npm",
      args: "run dev",
      cwd: "/home/brock/clawd/projects/mahoraga/dashboard",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "development",
        PORT: "5175",
        HOST: "0.0.0.0"
      }
    }
  ]
};
