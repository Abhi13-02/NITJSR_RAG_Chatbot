Mixing embedding models without changing modelKey → bad matches.

If you prefer to stop frontend auto-init entirely                                                                                                                        
                                                                                                                                                                           
  - Simple tweak (optional): In public/index.html, gate the initialize call with a flag:                                                                                   
      - Replace if (!data.initialized) with if (!data.initialized && !window.DISABLE_AUTO_INIT)                                                                            
      - Then set window.DISABLE_AUTO_INIT = true before the script, or from the browser console.