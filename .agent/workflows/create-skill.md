---
description: Create a new skill with standard directory structure and template
---

1. Ask the user for the name of the new skill (e.g., `my-new-skill`).
2. Ask the user if they want to create it as a **Global** skill (in `global_skills`) or **Local** skill (in current project's `.agent/skills`).
   - If **Global**: Target path is `<user_home>\.gemini\antigravity\global_skills\[skill-name]`
   - If **Local**: Target path is `.agent\skills\[skill-name]`
3. Create the skill directory `[Target Path]`.
4. Create subdirectories:
   - `[Target Path]\scripts`
   - `[Target Path]\references`
   - `[Target Path]\assets`
5. Create `[Target Path]\SKILL.md` with the following template:
    ```markdown
    ---
    name: [skill-name]
    description: [Short description of when to use this skill]
    ---
    
    # [Skill Name]
    
    ## Overview
    
    [Detailed description of what this skill does]
    
    ## Usage
    
    [Instructions on how to use]
    
    ## Resources
    
    - **Scripts**: 
    - **References**:
    ```
6. Notify the user that the skill has been created at `[Target Path]`.
