# Yalla Backend

Backend services for Yalla Journey.

Tech Stack:
- Node.js / TypeScript
- AWS Lambda
- Amazon DynamoDB
- Amazon API Gateway

Bundle 1 uses Cognito User Pool Guest credentials, atomic DynamoDB provisioning,
and JWT-protected Player / Progress / Wallet reads.

See [implementation and Unity integration](docs/05-bundle1-implementation.md).
Use Node.js 24 (`nvm use`), then `npm ci`, `npm run typecheck`, and `npm test`.
Deployment is explicit: `python3 scripts/deploy.py --environment dev --profile yalla-dev --region ap-south-1`.
