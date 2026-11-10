/* Loaded before app.js. Keep this bootstrap compatible with older browsers. */
(function () {
  'use strict';
  if (!window.globalThis) window.globalThis = window;
  if (!Object.fromEntries) {
    Object.defineProperty(Object, 'fromEntries', {configurable:true,writable:true,value:function (iterable) {
      var object = {};
      var iterator = iterable[Symbol.iterator]();
      var step;
      while (!(step = iterator.next()).done) {
        var entry = step.value;
        Object.defineProperty(object, entry[0], {value:entry[1],writable:true,enumerable:true,configurable:true});
      }
      return object;
    }});
  }
  if (document.documentElement && document.body) {
    var probe = document.createElement('div');
    probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    for (var i=0;i<2;i++) { var child=document.createElement('div'); child.style.height='1px'; probe.appendChild(child); }
    document.body.appendChild(probe);
    if (probe.scrollHeight !== 3) document.documentElement.classList.add('no-flex-gap');
    probe.remove();
  }
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true, writable: true,
      value: function (index) {
        var length = this.length;
        var n = Number(index) || 0;
        n = n < 0 ? Math.ceil(n) : Math.floor(n);
        if (n < 0) n += length;
        return n < 0 || n >= length ? undefined : this[n];
      }
    });
  }
  if (window.crypto && !window.crypto.randomUUID) {
    window.crypto.randomUUID = function () {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.prototype.map.call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
  }
  if (!HTMLFormElement.prototype.requestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function () {
      var button = document.createElement('button');
      button.type = 'submit';
      button.hidden = true;
      this.appendChild(button);
      button.click();
      button.remove();
    };
  }
}());
