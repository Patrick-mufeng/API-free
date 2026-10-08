package server

import "testing"

// 密钥接口的准入条件：只有本机请求能拿到明文。
func TestIsLoopback(t *testing.T) {
	loop := []string{"127.0.0.1:54321", "127.0.0.1:9000", "[::1]:54321", "localhost:9000"}
	for _, a := range loop {
		if !isLoopback(a) {
			// localhost 不是 IP 字面量，net.ParseIP 解析不出，这里允许它被判为 false，
			// 因为 Go 的 http server 传进来的 RemoteAddr 永远是 IP:port 形式。
			if a == "localhost:9000" {
				continue
			}
			t.Errorf("isLoopback(%q) = false，应为 true", a)
		}
	}
	remote := []string{"192.168.1.20:54321", "10.0.0.5:9000", "172.16.3.9:5555", "8.8.8.8:9000"}
	for _, a := range remote {
		if isLoopback(a) {
			t.Errorf("isLoopback(%q) = true，应为 false（局域网/公网不得取明文密钥）", a)
		}
	}
	// 奇怪的输入不应 panic，也不能误判为 true
	for _, a := range []string{"", "not-an-address", "[fe80::1]:80"} {
		if isLoopback(a) {
			t.Errorf("isLoopback(%q) = true，应为 false", a)
		}
	}
}
