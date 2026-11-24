# The production application uses Workers AI and OpenRouter, so its former
# direct OpenAI project is retired. Removing the three resource declarations
# deletes its model permissions and spend alert, then archives the project.
# OpenAI retains archived project history; a project cannot be fully deleted.
# Keep the provider configuration until this destroy plan has been applied.
