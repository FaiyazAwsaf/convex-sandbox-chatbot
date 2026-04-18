# Convex Sandbox Chatbot

This project implements a sandboxed chatbot architecture where every conversation spins up its own isolated VM running a Pi Agent. The agent can execute tools (bash, read/write/edit files, grep, glob, webfetch, websearch) inside its VM, while the Convex backend orchestrates threads, sessions, and tool logs.
