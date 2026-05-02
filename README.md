# Outback Game + VPS Panel

This is a new starter panel for game servers and container VPS hosting.

## What it includes

- PostgreSQL panel database
- Admin page
- Users with subdomain/database slots
- API keys with permissions
- Docker node agent
- Game server containers
- Container VPS services
- Server tabs:
  - Console/live logs/commands
  - File manager
  - Backups
  - Saves/worlds
  - Network ports
  - Subdomains
  - Databases
  - Subusers
  - Settings/delete
- VPS manage page with status/resources and factory reset endpoint

## Important note about VPS

This starter uses Docker containers as lightweight VPS services. That is not the same isolation as KVM/Proxmox virtual machines. For paid public VPS hosting, use extra security hardening or a real VM backend.

## Setup PostgreSQL on Ubuntu

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres psql
```

Inside psql:

```sql
CREATE USER outback_panel WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE outback_panel OWNER outback_panel;
\q
```

## Run panel

```bash
cd panel
npm install
cp .env.example .env
nano .env
node server.js
```

Open:

```text
http://localhost:3000
```

Default admin comes from `.env`:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin123
```

## Run node agent

Install Docker first:

```bash
sudo apt install -y docker.io
sudo systemctl enable --now docker
```

Run agent:

```bash
cd agent
npm install
cp .env.example .env
nano .env
node agent.js
```

Then add the node in Panel Admin:

```text
URL: http://YOUR_NODE_IP:4100
Token: same as AGENT_TOKEN in agent/.env
```

## API key for your sales website

Create an API key in the panel with:

```text
provision:user
provision:server
```

Your website can call:

```text
POST /api/v1/provision/order
```

Payload example:

```json
{
  "email": "customer@example.com",
  "username": "customer",
  "password": "ChangeMe123!",
  "serverType": "PAPER",
  "version": "1.21.11",
  "memoryMb": 2048,
  "storageLimitMb": 10240,
  "cpuLimit": 1,
  "port": 25565
}
```
