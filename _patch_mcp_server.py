import sys
with open('src/mcp-server.js', 'r') as f:
    content = f.read()

# Add the import after SafetyLayer line
old = 'const { SafetyLayer } = require("./safety");'
new = old + '\nconst { createAgentTools } = require("./mcp-tools");'
content = content.replace(old, new)

with open('src/mcp-server.js', 'w') as f:
    f.write(content)
print('OK')
