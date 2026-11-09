const e = '— 😀 é';
function neverRan() {
  return '— 😀 é'.length + 1;
}
function ranHere() {
  return '— 😀 é'.length + 2;
}
console.log(ranHere(), e, typeof neverRan);
console.log('ready');
setInterval(() => {}, 1000);
