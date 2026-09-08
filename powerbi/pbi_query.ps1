# Executa uma consulta (DAX ou DMV) contra o modelo do Power BI Desktop que
# estiver aberto no momento. Porta, catalogo e versao do Power BI sao
# autodetectados -- os tres mudam a cada sessao/atualizacao.
#
# Exemplos:
#   .\pbi_query.ps1                                   # lista as tabelas do modelo
#   .\pbi_query.ps1 -Query "EVALUATE Clientes"
#   .\pbi_query.ps1 -Query "EVALUATE ROW(""Total"", [Total Clientes])"
#   .\pbi_query.ps1 -Query "SELECT [Name],[Expression] FROM `$SYSTEM.TMSCHEMA_MEASURES"
#   .\pbi_query.ps1 -Query "EVALUATE Clientes" -Csv saida.csv
param(
    [string]$Query = "SELECT [Name],[IsHidden] FROM `$SYSTEM.TMSCHEMA_TABLES",
    [string]$Csv = "",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

# --- 1. Acha o motor tabular do Power BI aberto (processo msmdsrv)
# O diretorio do Power BI sai do proprio processo: o WindowsApps tem ACL que
# impede enumerar a pasta por wildcard, mas o caminho do exe vem de graca aqui.
$procs = @(Get-Process -Name msmdsrv -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { throw "Nenhuma instancia do Power BI Desktop aberta (processo msmdsrv nao esta rodando)." }
if ($procs.Count -gt 1) { Write-Warning "$($procs.Count) instancias do Power BI abertas; usando a mais recente. Use -Port para escolher outra." }
$proc = $procs | Sort-Object StartTime -Descending | Select-Object -First 1

$exe = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)").ExecutablePath
if (-not $exe) { $exe = $proc.Path }
$bin = Split-Path $exe -Parent
if (-not (Test-Path (Join-Path $bin "Microsoft.PowerBI.AdomdClient.dll"))) {
    throw "Microsoft.PowerBI.AdomdClient.dll nao encontrado em $bin"
}

# --- 2. Descobre a porta que esse msmdsrv esta escutando
if ($Port -le 0) {
    $Port = (Get-NetTCPConnection -State Listen -OwningProcess $proc.Id -ErrorAction SilentlyContinue |
             Where-Object { $_.LocalAddress -eq "127.0.0.1" } |
             Select-Object -First 1).LocalPort
    if (-not $Port) { throw "Nao consegui descobrir a porta do msmdsrv (PID $($proc.Id))." }
}

# --- 3. Carrega o cliente ADOMD (dependencias resolvem no diretorio do Power BI)
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
    param($sender, $e)
    $nome = (New-Object System.Reflection.AssemblyName($e.Name)).Name
    $dll = Join-Path $bin "$nome.dll"
    if (Test-Path $dll) { return [System.Reflection.Assembly]::LoadFrom($dll) }
    return $null
})
$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $bin "Microsoft.PowerBI.AdomdClient.dll"))
$connType = $asm.GetType("Microsoft.AnalysisServices.AdomdClient.AdomdConnection")

function Invoke-Pbi([string]$sql, [string]$catalogo) {
    $cs = "Data Source=localhost:$Port"
    if ($catalogo) { $cs += ";Initial Catalog=$catalogo" }
    $conn = [System.Activator]::CreateInstance($connType, @($cs))
    $conn.Open()
    try {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $reader = $cmd.ExecuteReader()
        $cols = @(); for ($i = 0; $i -lt $reader.FieldCount; $i++) { $cols += $reader.GetName($i) }
        $linhas = New-Object System.Collections.ArrayList
        while ($reader.Read()) {
            $o = [ordered]@{}
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                $v = $reader.GetValue($i)
                $o[$cols[$i]] = $(if ($v -is [System.DBNull]) { $null } else { $v })
            }
            [void]$linhas.Add([pscustomobject]$o)
        }
        $reader.Close()
        return ,$linhas
    } finally { $conn.Close() }
}

# --- 4. Descobre o catalogo (o GUID do modelo aberto) e roda a consulta
$catalogo = (Invoke-Pbi "SELECT [CATALOG_NAME] FROM `$SYSTEM.DBSCHEMA_CATALOGS" $null |
             Select-Object -First 1).CATALOG_NAME
Write-Host "Conectado: localhost:$Port  |  catalogo $catalogo" -ForegroundColor Cyan

$res = Invoke-Pbi $Query $catalogo

if ($Csv) {
    $res | Export-Csv -Path $Csv -NoTypeInformation -Encoding UTF8
    "{0} linhas gravadas em {1}" -f $res.Count, $Csv
} else {
    $res | Format-Table -AutoSize | Out-String -Width 400
    "({0} linhas)" -f $res.Count
}
