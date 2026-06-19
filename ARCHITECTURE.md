# Architecture Principles

## Minimize Application Logic, Maximize LLM Capability

The application should be a thin client that collects user information and passes it to the LLM with clear prompts. The LLM should handle logic, context understanding, and decision-making.

### Why

1. **Simplicity**: Less code to maintain, fewer edge cases in application logic
2. **Flexibility**: The LLM adapts to new cases naturally; regex parsers are brittle
3. **Quality**: LLM is better at understanding context, intent, and ambiguous input
4. **Coherence**: Single source of truth for recommendations (the LLM + prompt) rather than distributed logic

### Anti-pattern: Special Case Handling

Don't build application-level parsing for common cases. Examples to avoid:
- Direct title request parsing with regex patterns
- Special routing based on input format
- Substring generation or text manipulation
- Conditional logic based on input patterns

### The Right Pattern

```
User input (channel name, description, history) 
  → Pass to LLM with clear prompt
  → Parse response
  → Display result
```

If the LLM doesn't understand the input, improve the prompt—don't add special parsing.

### Example

**Wrong**: Parse "The Thing (1982)" with regex, check if it's a direct title request, handle it differently
**Right**: Pass "The Thing" to the LLM in the prompt. It understands what to do.

### Prompts Over Code

Every feature should be driven by:
1. What information do we have? (user input, history, preferences)
2. What should the LLM do with it? (clear, explicit prompt)
3. How do we display the response? (parsing + UI)

If you find yourself writing complex application logic, ask: could the LLM do this with a better prompt?
