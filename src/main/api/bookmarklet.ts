export const CAPTURE_PATH = '/capture'

/**
 * The `javascript:` bookmark that sends the current page to Cairn.
 *
 * It opens a small pop-up on the local server instead of calling fetch(): a pop-up is a plain navigation, so it
 * works on sites with a strict Content-Security-Policy, from https pages, and in browsers that block requests to
 * local addresses. The page's address, its title and any text you selected (used as the note) are sent; the app
 * looks up the details itself. Browsers percent-decode `javascript:` bookmarks, so the code must not contain "%".
 */
export function buildBookmarklet(port: number, key: string): string {
  const base = 'http://127.0.0.1:' + port + CAPTURE_PATH + '?k=' + encodeURIComponent(key)
  const code = [
    '(function(){',
    // Cut to a length, then percent-encode; a cut in the middle of an emoji would throw, so retry one shorter.
    'var c=function(x,n){x=String(x||"").slice(0,n);try{return encodeURIComponent(x)}catch(e){return encodeURIComponent(x.slice(0,-1))}};',
    'var s="";try{s=String(window.getSelection()||"").trim()}catch(e){}',
    'var u=' + JSON.stringify(base) + '+"&url="+c(location.href,2000)+"&title="+c(document.title,300)+(s?"&note="+c(s,1000):"");',
    'var w=window.open(u,"cairn-capture","popup=yes,width=440,height=280");',
    'if(!w){alert("Cairn: your browser blocked the pop-up window. Allow pop-ups for this site and try again.")}',
    '})();'
  ].join('')
  return 'javascript:' + code
}
