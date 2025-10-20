#!/bin/bash

echo "╔═══════════════════════════════════════════════════════╗"
echo "║   ThinkDrop Web Search Service Setup                 ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# Check Node.js version
echo "Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Error: Node.js 18 or higher is required"
    echo "   Current version: $(node -v)"
    exit 1
fi
echo "✓ Node.js version OK: $(node -v)"
echo ""

# Install dependencies
echo "Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi
echo "✓ Dependencies installed"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
    echo "✓ .env file created"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env and add your API keys:"
    echo "   - NEWSAPI_KEY (get one at https://newsapi.org)"
    echo "   - API_KEY (create a secure random key)"
    echo ""
else
    echo "✓ .env file already exists"
    echo ""
fi

# Initialize database
echo "Initializing database..."
npm run db:init
if [ $? -ne 0 ]; then
    echo "❌ Failed to initialize database"
    exit 1
fi
echo "✓ Database initialized"
echo ""

echo "╔═══════════════════════════════════════════════════════╗"
echo "║   Setup Complete!                                     ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your API keys"
echo "  2. Run 'npm run dev' to start the development server"
echo "  3. Visit http://localhost:3002/service.health to verify"
echo ""
